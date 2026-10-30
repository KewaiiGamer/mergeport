import { randomUUID } from "node:crypto";
import type { Prisma, Space } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { GithubError } from "@/lib/github/port";
import { HubError, type Backend, type EntityEvent, type HubClient } from "@/lib/hub/types";
import { mapLimit } from "@/lib/util";
import { ENTITY_SCHEMA, ENTITY_TYPES, entityDef, entityPath, parseEntityPath, type Ctx, type EntityDef, type Listed } from "./entities";
import { same, threeWayMerge, type Data } from "./merge";
import { CoordinationStore, HeadMovedError, type Head } from "./store";

/**
 * Local sync engine for coordination spaces.
 *
 *   edit locally -> OutboxOp (durable, written first) -> push as ONE atomic commit built on the head we read
 *   poll head (conditional) -> fetch only changed entity blobs -> three-way merge -> local read model
 *
 * Never force-pushes. Never trusts local clocks for ordering. A response lost after a successful commit is detected
 * by the operation id recorded in the entity file, so a retry never applies an operation twice.
 */

export const MANIFEST_SCHEMA = 1;
export const MAX_POLL_MS = 2 * 60_000; // an idle space is still checked at least this often, so a teammate's edit never waits long
export const REVOKED_RECHECK_MS = 10 * 60_000;

export type SpaceState = "synced" | "pending" | "syncing" | "offline" | "conflict" | "revoked" | "rate-limited" | "schema" | "read-only";

export type Manifest = { schema: number; kind: "mergeport-space"; spaceId: string; teamId: string; teamName: string; spaceKind: "COMMON" | "RESTRICTED"; name: string; createdAt: string; createdBy: { id: string; login: string } };

export function parseManifest(text: string): Manifest | { error: string } {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return { error: "mergeport.json is not valid JSON" };
  }
  if (!m || m.kind !== "mergeport-space") return { error: "This repository is not a Mergeport coordination space" };
  if (typeof m.schema !== "number") return { error: "Manifest has no schema version" };
  if (typeof m.spaceId !== "string" || typeof m.teamId !== "string" || (m.spaceKind !== "COMMON" && m.spaceKind !== "RESTRICTED")) return { error: "Manifest is missing required fields" };
  return m as Manifest;
}

/** One local copy a hub restore replaced. */
export type RestoreEntry = { type: string; entityId: string; deleted: boolean; data: Data; resend: boolean; /** The hub's version of the entity when the restore was detected (0: absent). */ hubVersion: number };
const RESTORE_DETAIL_CAP = 100;

export type EntityFile = { schema: number; type: string; id: string; version: number; deleted: boolean; appliedOps: string[]; updatedAt: string; updatedBy: { id: string; login: string }; data: Data };

function parseEntity(text: string, expect: { type: string; id: string }): EntityFile | { error: string } {
  let f: any;
  try {
    f = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  if (!f || typeof f !== "object" || typeof f.schema !== "number" || f.type !== expect.type || f.id !== expect.id || !Number.isInteger(f.version) || typeof f.data !== "object" || f.data === null) return { error: "unexpected shape" };
  return { schema: f.schema, type: f.type, id: f.id, version: f.version, deleted: !!f.deleted, appliedOps: Array.isArray(f.appliedOps) ? f.appliedOps.map(String) : [], updatedAt: String(f.updatedAt ?? ""), updatedBy: f.updatedBy ?? { id: "", login: "" }, data: f.data };
}

export type EngineDeps = {
  db: Db;
  store: (space: Space) => CoordinationStore;
  actor: { id: bigint; login: string };
  now?: () => Date;
  random?: () => number;
  newOpId?: () => string;
  onChange?: (e: { spaceId: string; reason: "pulled" | "pushed" | "state" }) => void;
  hub?: (space: Space) => HubClient;
  hubLive?: () => boolean;
};

const PERMISSION_RECHECK_MS = 5 * 60_000;
const PUSH_PERMISSION_RECHECK_MS = 60_000;
const isBlocked = (se: { meta: unknown } | null | undefined) => !!(se?.meta as { newer?: boolean } | null)?.newer;

export class SyncEngine {
  private syncing = new Set<string>();
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? (() => new Date());
    this.random = d.random ?? Math.random;
  }
  private get db() {
    return this.d.db;
  }
  private opId() {
    return (this.d.newOpId ?? randomUUID)();
  }
  private emit(spaceId: string, reason: "pulled" | "pushed" | "state") {
    this.d.onChange?.({ spaceId, reason });
  }
  private backendOf(space: Space): Backend {
    if (space.backend === "HUB") {
      if (!this.d.hub) throw new Error("No hub client configured");
      return { kind: "hub", client: this.d.hub(space) };
    }
    return { kind: "github", store: this.d.store(space) };
  }

  // ---------- context ----------

  private async ctx(space: Space): Promise<Ctx> {
    const ws = await this.db.workspace.findFirstOrThrow();
    const member = await this.db.member.findFirstOrThrow({ where: { workspaceId: ws.id, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    return { workspaceId: ws.id, localMemberId: member.id, space, commonSpaceId: team?.commonSpaceId ?? null };
  }

  private readonly permAt = new Map<string, number>();
  private permissionsStale(space: Space, maxAgeMs: number): boolean {
    return this.now().getTime() - (this.permAt.get(space.id) ?? 0) >= maxAgeMs;
  }

  /** Remembers that an entity file was written by a newer Mergeport, so this client never rewrites it. */
  private async blockEntity(spaceId: string, type: string, id: string, sha: string, version: number) {
    const key = { spaceId_type_entityId: { spaceId, type, entityId: id } };
    const existing = await this.db.syncEntity.findUnique({ where: key });
    if (existing) await this.db.syncEntity.update({ where: key, data: { remoteSha: sha, meta: { ...(existing.meta as object | null), newer: true } as Prisma.InputJsonValue } });
    else await this.db.syncEntity.create({ data: { spaceId, type, entityId: id, path: entityPath(type, id), remoteSha: sha, baseVersion: version, baseData: {}, meta: { newer: true } as Prisma.InputJsonValue, deleted: true } });
  }

  private async localMap(def: EntityDef, commonSpaceId: string | null): Promise<Map<string, Listed>> {
    return new Map((await def.list(this.db, { commonSpaceId })).map((l) => [l.id, l]));
  }

  // ---------- capture local edits into the outbox ----------

  /** Diffs the local read model against what each space last agreed on and writes durable outbox operations. */
  async capture(): Promise<number> {
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    const commonSpaceId = team?.commonSpaceId ?? null;
    const spaces = new Map((await this.db.space.findMany({ where: { access: "OK", canWrite: true } })).map((s) => [s.id, s]));
    let created = 0;
    for (const def of ENTITY_TYPES) {
      const listed = (await def.list(this.db, { commonSpaceId })).filter((l) => l.spaceId && spaces.has(l.spaceId));
      const seen = new Set<string>();
      for (const l of listed) {
        const spaceId = l.spaceId!;
        seen.add(`${spaceId}|${l.id}`);
        const se = await this.db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId, type: def.type, entityId: l.id } } });
        const pending = await this.db.outboxOp.findFirst({ where: { spaceId, entityType: def.type, entityId: l.id, status: { in: ["PENDING", "CONFLICT"] } }, orderBy: { createdAt: "desc" } });
        if (pending?.status === "CONFLICT") continue;
        if (isBlocked(se)) continue; // written by a newer Mergeport: never rewrite it
        if (await this.db.outboxOp.count({ where: { spaceId, entityType: def.type, entityId: l.id, status: "QUARANTINED" } })) continue; // waits for retry or discard
        if (se && !se.deleted && same(se.baseData, l.data)) {
          if (pending) await this.db.outboxOp.delete({ where: { id: pending.id } }); // the edit was reverted
          continue;
        }
        if (pending) {
          if (!same(pending.data, l.data)) await this.db.outboxOp.update({ where: { id: pending.id }, data: { data: l.data as Prisma.InputJsonValue } });
          continue;
        }
        await this.db.outboxOp.create({ data: { id: this.opId(), spaceId, entityType: def.type, entityId: l.id, kind: "UPSERT", data: l.data as Prisma.InputJsonValue, baseVersion: se?.baseVersion ?? 0 } });
        created++;
      }
      const known = await this.db.syncEntity.findMany({ where: { type: def.type, deleted: false, spaceId: { in: [...spaces.keys()] } } });
      for (const se of known) {
        if (seen.has(`${se.spaceId}|${se.entityId}`) || isBlocked(se)) continue;
        if (await this.db.outboxOp.count({ where: { spaceId: se.spaceId, entityType: def.type, entityId: se.entityId, status: "QUARANTINED" } })) continue;
        const pending = await this.db.outboxOp.findFirst({ where: { spaceId: se.spaceId, entityType: def.type, entityId: se.entityId, status: { in: ["PENDING", "CONFLICT", "SENT"] } } });
        if (pending) continue;
        await this.db.outboxOp.create({ data: { id: this.opId(), spaceId: se.spaceId, entityType: def.type, entityId: se.entityId, kind: "DELETE", baseVersion: se.baseVersion } });
        created++;
      }
    }
    if (created) for (const s of spaces.values()) this.emit(s.id, "state");
    return created;
  }

  // ---------- pull ----------

  async pullSpace(space0: Space): Promise<{ changed: boolean; applied: number }> {
    if (space0.backend === "HUB") return this.pullHub(space0);
    return this.pullGithub(space0);
  }

  private async pullHub(space0: Space): Promise<{ changed: boolean; applied: number }> {
    const backend = this.backendOf(space0);
    if (backend.kind !== "hub") throw new Error("Not a hub space");
    const client = backend.client;
    const space = space0;
    // A revoked space is reopened by syncHubSpaces (the hub's member list), never by a pull that happens to succeed.
    if (space.access === "REVOKED") return { changed: false, applied: 0 };
    const start = space.hubCursor;
    // The cursor is a position in THIS hub's history. A hub that answers with an older position or with a different op at our position
    // (restored from a backup, then moved on) is not the history we followed: `restored`, and local state is compared with the hub's before it is replaced.
    // A hub that no longer holds our position because it pruned it is not a restore: the snapshot only moves forward.
    let since = start;
    let cursor = start;
    let cursorOp = space.hubCursorOp;
    let restored: false | "certain" | "suspected" = false;
    let epoch = space.hubEpoch;
    const events: EntityEvent[] = [];
    let snapshot: { epoch?: string; seq: bigint; seqOp?: string; entities: EntityFile[] } | null = null;
    try {
      for (;;) {
        const r = await client.pull(space.hubSpaceId, since, cursorOp || undefined);
        if (await this.revokedMeanwhile(space.id)) return { changed: false, applied: 0 };
        // A different hub process than the one this cursor came from may be serving a database restored from a backup: its history can look
        // like a continuation of ours without being one (our own pushes are not in our cursor). Compare with a snapshot instead of trusting events.
        const newProcess = r !== "gone" && r !== "history" && !!space.hubEpoch && !!r.epoch && r.epoch !== space.hubEpoch;
        if (r === "gone" || r === "history" || r.seq < since || newProcess) {
          restored = r === "history" || (r !== "gone" && r.seq < since) ? "certain" : newProcess ? "suspected" : false;
          snapshot = await client.snapshot(space.hubSpaceId);
          if (await this.revokedMeanwhile(space.id)) return { changed: false, applied: 0 };
          cursor = snapshot.seq;
          cursorOp = snapshot.seqOp ?? "";
          epoch = snapshot.epoch ?? epoch;
          break;
        }
        epoch = r.epoch ?? epoch;
        events.push(...r.events);
        const last = r.events[r.events.length - 1];
        if (r.more && last) {
          since = last.seq;
          cursor = last.seq;
          cursorOp = last.opId;
          continue;
        }
        cursor = r.seq;
        cursorOp = r.seqOp ?? last?.opId ?? "";
        break;
      }
    } catch (e) {
      await this.handleHubError(space, e, "read");
      return { changed: false, applied: 0 };
    }

    // Only the newest event per entity matters; the hub's version is the whole state.
    let items: { file: EntityFile; seq: bigint }[];
    if (snapshot) {
      const seq = snapshot.seq;
      items = snapshot.entities.filter((f) => !!entityDef(f.type)).map((file) => ({ file, seq }));
    } else {
      const latest = new Map<string, { file: EntityFile; seq: bigint }>();
      for (const ev of events) {
        if (!entityDef(ev.type)) continue; // unknown types are ignored (and never rewritten)
        const prev = latest.get(`${ev.type}/${ev.id}`);
        if (!prev || ev.seq > prev.seq) latest.set(`${ev.type}/${ev.id}`, { file: ev, seq: ev.seq });
      }
      items = [...latest.values()];
    }
    let vanished: { type: string; entityId: string; baseVersion: number }[] = [];
    if (snapshot) {
      const present = new Set(snapshot.entities.map((f) => `${f.type}/${f.id}`));
      vanished = (await this.db.syncEntity.findMany({ where: { spaceId: space.id, deleted: false } })).filter((s) => !!entityDef(s.type) && !present.has(`${s.type}/${s.entityId}`));
    }

    const ctx = await this.ctx(space);
    const replaced = restored && snapshot ? await this.collectRestoreLoss(ctx, snapshot.entities, restored === "certain") : null;
    const { applied, skipped, failedSeq } = await this.applyHubEntities(ctx, items, vanished);
    if (failedSeq !== null) {
      // The cursor stays before the first entity that could not be applied, so the next pull retries it.
      if (snapshot) {
        cursor = start;
        cursorOp = space.hubCursorOp;
      } else if (failedSeq - 1n < cursor) {
        cursor = failedSeq - 1n < start ? start : failedSeq - 1n;
        // The op at a cursor this far back is not known here; the hub skips the position check when it is not given one.
        cursorOp = cursor === start ? space.hubCursorOp : "";
      }
    } else if (replaced && (replaced.rolledBack > 0 || (restored === "certain" && replaced.kept > 0))) {
      // Unsent edits alone are not a loss; after a mere restart (suspected) they are not worth a notice.
      await this.db.hubRestore.create({ data: { spaceId: space.id, rolledBack: replaced.rolledBack, kept: replaced.kept, detail: replaced.detail as Prisma.InputJsonValue } });
      this.emit(space.id, "state");
    }

    const now = this.now();
    const moved = cursor !== start;
    await this.db.space.update({
      where: { id: space.id },
      data: {
        hubCursor: cursor, hubCursorOp: cursorOp, hubEpoch: failedSeq !== null && snapshot ? space.hubEpoch : epoch, lastPolledAt: now, ...(applied || moved ? { lastChangedAt: now, unchangedPolls: 0 } : {}),
        rateLimitedUntil: null,
        lastError: skipped.length ? `Skipped ${skipped.length} unreadable entity(ies): ${skipped[0]}` : null,
      },
    });
    await this.schedule({ ...space, unchangedPolls: applied || moved ? 0 : space.unchangedPolls }, applied || moved ? "changed" : "unchanged");
    if (applied) this.emit(space.id, "pulled");
    return { changed: applied > 0 || moved, applied };
  }

  /**
   * The hub's history is not the one this computer followed. Before the hub's state replaces local state, record which clean local copies are about to
   * be replaced (`kept` counts entities with unsent edits: reconcile merges those against the restored state and never drops them).
   * `resend` marks a copy that is provably newer than what the hub now holds (higher version, or gone from the hub): those can be sent back on request.
   */
  private async collectRestoreLoss(ctx: Ctx, entities: EntityFile[], certain: boolean): Promise<{ rolledBack: number; kept: number; detail: RestoreEntry[] }> {
    const space = ctx.space;
    const hub = new Map(entities.map((f) => [`${f.type}/${f.id}`, f]));
    let rolledBack = 0;
    const detail: RestoreEntry[] = [];
    const unsent = new Set((await this.db.outboxOp.findMany({ where: { spaceId: space.id, status: { in: ["PENDING", "SENT", "CONFLICT"] } }, select: { entityType: true, entityId: true } })).map((o) => `${o.entityType}/${o.entityId}`));
    for (const def of ENTITY_TYPES) {
      const local = await this.localMap(def, ctx.commonSpaceId);
      for (const se of await this.db.syncEntity.findMany({ where: { spaceId: space.id, type: def.type } })) {
        const row = local.get(se.entityId);
        if (row?.spaceId && row.spaceId !== space.id) continue;
        if (unsent.has(`${def.type}/${se.entityId}`)) continue;
        const h = hub.get(`${def.type}/${se.entityId}`);
        const base = (se.baseData as Data | null) ?? {};
        const differs = h ? h.deleted !== se.deleted || (!h.deleted && !same(h.data, base)) : !se.deleted;
        if (!differs) continue;
        // Only when the hub's history is known to differ from ours is a hub entity that is ahead of our copy a loss; a restarted hub whose
        // history may simply be a continuation is expected to be ahead, and that is an ordinary remote edit.
        const resend = h ? h.version <= se.baseVersion : true;
        if (!certain && !resend) continue;
        rolledBack++;
        if (detail.length >= RESTORE_DETAIL_CAP) continue;
        detail.push({ type: def.type, entityId: se.entityId, deleted: se.deleted || !row, data: row?.data ?? base, resend, hubVersion: h?.version ?? 0 });
      }
    }
    return { rolledBack, kept: unsent.size, detail };
  }

  /** Puts the local copies a restore replaced back as ordinary unsent edits, against the hub's current versions. */
  async resendRestored(restoreId: string): Promise<{ queued: number }> {
    const rec = await this.db.hubRestore.findUniqueOrThrow({ where: { id: restoreId } });
    if (rec.status !== "OPEN") return { queued: 0 };
    const space = await this.db.space.findUniqueOrThrow({ where: { id: rec.spaceId } });
    const ctx = await this.ctx(space);
    let queued = 0;
    for (const e of rec.detail as unknown as RestoreEntry[]) {
      const def = entityDef(e.type);
      if (!def || !e.resend) continue;
      const key = { spaceId_type_entityId: { spaceId: space.id, type: e.type, entityId: e.entityId } };
      const se = await this.db.syncEntity.findUnique({ where: key });
      // Anything done to this entity since the restore wins over the old copy.
      if (await this.db.outboxOp.count({ where: { spaceId: space.id, entityType: e.type, entityId: e.entityId, status: { in: ["PENDING", "SENT", "CONFLICT", "QUARANTINED"] } } })) continue;
      const local = (await this.localMap(def, ctx.commonSpaceId)).get(e.entityId);
      const base = (se?.baseData as Data | null) ?? {};
      if (local && !same(local.data, base)) continue;
      // Against the hub's version when the restore was seen: if it has moved since, the push answers stale and the ordinary merge decides.
      if (!e.deleted) await def.apply(this.db, ctx, e.entityId, e.data, e.hubVersion);
      await this.db.outboxOp.create({ data: { id: this.opId(), spaceId: space.id, entityType: e.type, entityId: e.entityId, kind: e.deleted ? "DELETE" : "UPSERT", ...(e.deleted ? {} : { data: e.data as Prisma.InputJsonValue }), baseVersion: e.hubVersion } });
      queued++;
    }
    await this.db.hubRestore.update({ where: { id: restoreId }, data: { status: "RESENT" } });
    this.emit(space.id, "state");
    return { queued };
  }

  async dismissRestored(restoreId: string): Promise<void> {
    await this.db.hubRestore.updateMany({ where: { id: restoreId, status: "OPEN" }, data: { status: "DISMISSED" } });
  }

  /** The per-entity apply loop for hub events and snapshots: same guards as a GitHub pull, in ENTITY_TYPES order. */
  private async applyHubEntities(ctx: Ctx, items: { file: EntityFile; seq: bigint }[], vanished: { type: string; entityId: string; baseVersion: number }[]) {
    const space = ctx.space;
    let applied = 0;
    const skipped: string[] = [];
    let failedSeq: bigint | null = null;
    const fail = (seq: bigint, msg: string) => {
      skipped.push(msg);
      if (failedSeq === null || seq < failedSeq) failedSeq = seq;
    };
    for (const def of ENTITY_TYPES) {
      const local = await this.localMap(def, ctx.commonSpaceId);
      const appliedHere: { id: string; data: Data }[] = [];
      for (const { file, seq } of items.filter((i) => i.file.type === def.type)) {
        const name = `${file.type}/${file.id}`;
        if (file.schema > ENTITY_SCHEMA) {
          skipped.push(`${name}: needs a newer Mergeport`);
          await this.blockEntity(space.id, def.type, file.id, String(seq), file.version);
          continue;
        }
        // An entity this person has placed in ANOTHER space is not overwritten, moved or deleted from here.
        const row = local.get(file.id);
        if (row?.spaceId && row.spaceId !== space.id) continue;
        try {
          const r = await this.reconcile(ctx, def, file, String(seq), row?.data ?? null);
          if (r.applied) {
            applied++;
            if (r.data) appliedHere.push({ id: file.id, data: r.data });
          } else {
            // Not recorded: a prerequisite entity is not there yet. Hold the cursor so it is retried.
            const se = await this.db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId: space.id, type: def.type, entityId: file.id } } });
            if (!se || se.baseVersion !== file.version) fail(seq, `${name}: waiting for a related entity`);
          }
        } catch (e) {
          fail(seq, `${name}: ${e instanceof Error ? e.message : "could not be applied"}`);
        }
      }
      for (const v of vanished.filter((s) => s.type === def.type)) {
        const owner = local.get(v.entityId);
        if (owner?.spaceId && owner.spaceId !== space.id) continue;
        const hasLocalEdits = (await this.db.outboxOp.count({ where: { spaceId: space.id, entityType: def.type, entityId: v.entityId, status: { in: ["PENDING", "SENT", "CONFLICT"] } } })) > 0;
        if (hasLocalEdits) continue;
        await def.apply(this.db, ctx, v.entityId, null, v.baseVersion);
        await this.db.syncEntity.update({ where: { spaceId_type_entityId: { spaceId: space.id, type: def.type, entityId: v.entityId } }, data: { deleted: true, remoteSha: null } });
        applied++;
      }
      if (def.post && appliedHere.length) await def.post(this.db, ctx, appliedHere);
    }
    return { applied, skipped, failedSeq: failedSeq as bigint | null };
  }

  private async pullGithub(space0: Space): Promise<{ changed: boolean; applied: number }> {
    let space = space0;
    const store = this.d.store(space);
    const now = this.now();
    let head: Head | null | "empty";
    try {
      // Permissions are refreshed on first contact and periodically, from GitHub itself: never from repository content.
      if (space.headSha === null || this.permissionsStale(space, PERMISSION_RECHECK_MS)) space = await this.refreshPermissions(space, store);
      if (space.access !== "OK") return { changed: false, applied: 0 };
      head = await store.head(space.branch, space.etag);
    } catch (e) {
      await this.handleError(space, e, "read");
      return { changed: false, applied: 0 };
    }
    if (head === null) {
      await this.schedule(space, "unchanged");
      return { changed: false, applied: 0 };
    }
    if (head === "empty") {
      await this.schedule(space, "unchanged");
      return { changed: false, applied: 0 };
    }
    let tree;
    try {
      tree = await store.tree(head.treeSha);
    } catch (e) {
      await this.handleError(space, e, "read");
      return { changed: false, applied: 0 };
    }

    const entries = new Map(tree.map((t) => [t.path, t.sha]));
    // manifest and schema gate
    const mSha = entries.get("mergeport.json");
    {
      const man = mSha ? parseManifest(await store.blob(mSha).catch(() => "")) : ({ error: "This repository has no Mergeport manifest" } as const);
      if ("error" in man || man.spaceId !== space.remoteId) {
        // Not (or no longer) the space we joined: a replaced or renamed repository is never silently trusted.
        await this.db.space.update({ where: { id: space.id }, data: { lastError: "error" in man ? man.error : "This repository is not the space you joined (its identity changed). Nothing was read from it." } });
        await this.schedule(space, "error");
        return { changed: false, applied: 0 };
      }
      if (man.schema > MANIFEST_SCHEMA) {
        await this.db.space.update({ where: { id: space.id }, data: { access: "SCHEMA_NEWER", lastError: "This space was written by a newer Mergeport. Update the app; this space is read-only until then." } });
        this.emit(space.id, "state");
        return { changed: false, applied: 0 };
      }
    }

    const known = new Map((await this.db.syncEntity.findMany({ where: { spaceId: space.id } })).map((s) => [`${s.type}/${s.entityId}`, s]));
    const changedFiles: { type: string; id: string; sha: string }[] = [];
    for (const [path, sha] of entries) {
      const p = parseEntityPath(path);
      if (!p || !entityDef(p.type)) continue; // unknown types are ignored (and never rewritten)
      if (known.get(`${p.type}/${p.id}`)?.remoteSha !== sha) changedFiles.push({ ...p, sha });
    }
    const vanished = [...known.values()].filter((s) => !s.deleted && !entries.has(s.path));

    const blobs = await mapLimit(changedFiles, 5, async (f) => ({ f, text: await store.blob(f.sha) })).catch(async (e) => {
      await this.handleError(space, e, "read");
      return null;
    });
    if (!blobs) return { changed: false, applied: 0 };

    const ctx = await this.ctx(space);
    let applied = 0;
    const skipped: string[] = [];
    for (const def of ENTITY_TYPES) {
      const local = await this.localMap(def, ctx.commonSpaceId);
      const appliedHere: { id: string; data: Data }[] = [];
      for (const { f, text } of blobs.filter((b) => b.f.type === def.type)) {
        const parsed = parseEntity(text, { type: f.type, id: f.id });
        if ("error" in parsed) {
          skipped.push(`${f.type}/${f.id}: ${parsed.error}`);
          continue;
        }
        if (parsed.schema > ENTITY_SCHEMA) {
          skipped.push(`${f.type}/${f.id}: needs a newer Mergeport`);
          await this.blockEntity(space.id, def.type, f.id, f.sha, parsed.version);
          continue;
        }
        // A file belongs to the space it lives in. An entity this person has placed in ANOTHER space is not
        // overwritten, moved or deleted by a file (or tombstone) arriving from here.
        const row = local.get(f.id);
        if (row?.spaceId && row.spaceId !== space.id) continue;
        let r: { applied: boolean; data: Data | null };
        try {
          r = await this.reconcile(ctx, def, parsed, f.sha, row?.data ?? null);
        } catch (e) {
          skipped.push(`${f.type}/${f.id}: ${e instanceof Error ? e.message : "could not be applied"}`);
          continue;
        }
        if (r.applied) {
          applied++;
          if (r.data) appliedHere.push({ id: f.id, data: r.data });
        }
      }
      for (const v of vanished.filter((s) => s.type === def.type)) {
        // The file disappeared from the tree (someone removed it outside Mergeport): treat as a remote deletion.
        const owner = local.get(v.entityId);
        if (owner?.spaceId && owner.spaceId !== space.id) continue;
        const hasLocalEdits = (await this.db.outboxOp.count({ where: { spaceId: space.id, entityType: def.type, entityId: v.entityId, status: { in: ["PENDING", "SENT"] } } })) > 0;
        if (hasLocalEdits) continue;
        await def.apply(this.db, ctx, v.entityId, null, v.baseVersion);
        await this.db.syncEntity.update({ where: { spaceId_type_entityId: { spaceId: space.id, type: def.type, entityId: v.entityId } }, data: { deleted: true, remoteSha: null } });
        applied++;
      }
      if (def.post && appliedHere.length) await def.post(this.db, ctx, appliedHere);
    }

    await this.refreshRole();
    await this.db.space.update({ where: { id: space.id }, data: { headSha: head.sha, etag: head.etag, lastPolledAt: now, lastChangedAt: now, unchangedPolls: 0, lastError: skipped.length ? `Skipped ${skipped.length} unreadable entity file(s): ${skipped[0]}` : null, rateLimitedUntil: null } });
    await this.schedule({ ...space, headSha: head.sha, etag: head.etag }, "changed");
    if (applied) this.emit(space.id, "pulled");
    return { changed: true, applied };
  }

  /** One entity: apply remote, merge with local edits, or record a conflict. */
  private async reconcile(ctx: Ctx, def: EntityDef, file: EntityFile, sha: string, local: Data | null): Promise<{ applied: boolean; data: Data | null }> {
    const spaceId = ctx.space.id;
    const key = { spaceId_type_entityId: { spaceId, type: def.type, entityId: file.id } };
    const se = await this.db.syncEntity.findUnique({ where: key });
    const remoteData: Data | null = file.deleted ? null : file.data;
    const base = (se?.baseData as Data | null) ?? null;
    const pending = await this.db.outboxOp.findFirst({ where: { spaceId, entityType: def.type, entityId: file.id, status: { in: ["PENDING", "SENT", "CONFLICT"] } }, orderBy: { createdAt: "desc" } });
    const localDeleted = !!se && !se.deleted && local === null;
    if (pending?.status === "CONFLICT") {
      // The person has not decided yet. Keep the decision open against the NEWEST remote; never merge or unpause behind their back.
      const open = await this.db.syncConflict.findFirst({ where: { spaceId, entityType: def.type, entityId: file.id, status: "OPEN" } });
      if (open) {
        const conflictBase = (open.base as Data) ?? {};
        const mine = (open.local as Data) ?? {};
        const fields = remoteData !== null && Object.keys(mine).length ? threeWayMerge(conflictBase, mine, remoteData, def.setKeys).conflicts : (open.fields as string[]);
        await this.db.syncConflict.update({ where: { id: open.id }, data: { remote: (remoteData ?? {}) as Prisma.InputJsonValue, remoteVersion: file.version, fields: (fields.length ? fields : (open.fields as string[])) as Prisma.InputJsonValue } });
      }
      await this.db.syncEntity.updateMany({ where: { spaceId, type: def.type, entityId: file.id }, data: { remoteSha: sha, baseVersion: file.version } });
      this.emit(spaceId, "state");
      return { applied: false, data: null };
    }
    // The remote file is exactly what we last agreed on (our own push, seen again): only remember its blob id.
    if (se && se.baseVersion === file.version && file.deleted === se.deleted && (file.deleted || same(file.data, base))) {
      await this.db.syncEntity.update({ where: key, data: { remoteSha: sha, meta: { applied: file.appliedOps } as Prisma.InputJsonValue } });
      return { applied: false, data: null };
    }
    const localChanged = !!pending || (!!se && local !== null && !same(local, base)) || localDeleted;

    const record = async (data: Data | null) => {
      const meta = { applied: file.appliedOps };
      const row = { path: entityPath(def.type, file.id), remoteSha: sha, baseVersion: file.version, baseData: (data ?? {}) as Prisma.InputJsonValue, meta: meta as Prisma.InputJsonValue, deleted: data === null };
      await this.db.syncEntity.upsert({ where: key, create: { spaceId, type: def.type, entityId: file.id, ...row }, update: row });
    };

    if (!localChanged) {
      const ok = await def.apply(this.db, ctx, file.id, remoteData, file.version);
      if (ok === false) return { applied: false, data: null };
      await record(remoteData);
      return { applied: true, data: remoteData };
    }

    // Local edits exist.
    if (remoteData === null && (local === null || localDeleted)) {
      await def.apply(this.db, ctx, file.id, null, file.version);
      await record(null);
      if (pending) await this.db.outboxOp.deleteMany({ where: { id: pending.id } });
      return { applied: true, data: null };
    }
    if (remoteData === null || local === null) {
      await this.openConflict(ctx, def, file, ["__deleted"], base ?? {}, local ?? {}, remoteData ?? {}, pending?.id ?? null);
      await record(remoteData);
      return { applied: false, data: null };
    }
    const m = threeWayMerge(base, pending?.data && !same(pending.data, local) ? (local as Data) : local, remoteData, def.setKeys);
    if (m.conflicts.length === 0) {
      await def.apply(this.db, ctx, file.id, m.merged, file.version);
      await record(remoteData); // the remote is the new agreement; our merged value is a fresh local edit on top of it
      if (same(m.merged, remoteData)) {
        if (pending) await this.db.outboxOp.deleteMany({ where: { id: pending.id } });
      } else if (pending) await this.db.outboxOp.update({ where: { id: pending.id }, data: { data: m.merged as Prisma.InputJsonValue, baseVersion: file.version, status: "PENDING" } });
      else await this.db.outboxOp.create({ data: { id: this.opId(), spaceId, entityType: def.type, entityId: file.id, kind: "UPSERT", data: m.merged as Prisma.InputJsonValue, baseVersion: file.version } });
      return { applied: true, data: m.merged };
    }
    await this.openConflict(ctx, def, file, m.conflicts, base ?? {}, local, remoteData, pending?.id ?? null);
    await record(remoteData);
    return { applied: false, data: null };
  }

  private async openConflict(ctx: Ctx, def: EntityDef, file: EntityFile, fields: string[], base: Data, local: Data, remote: Data, opId: string | null) {
    const spaceId = ctx.space.id;
    // The held operation carries this person's value; it is paused (CONFLICT) until they choose.
    if (opId) await this.db.outboxOp.update({ where: { id: opId }, data: { status: "CONFLICT" } });
    else {
      opId = this.opId();
      await this.db.outboxOp.create({ data: { id: opId, spaceId, entityType: def.type, entityId: file.id, kind: Object.keys(local).length ? "UPSERT" : "DELETE", data: Object.keys(local).length ? (local as Prisma.InputJsonValue) : undefined, baseVersion: file.version, status: "CONFLICT" } });
    }
    const open = await this.db.syncConflict.findFirst({ where: { spaceId, entityType: def.type, entityId: file.id, status: "OPEN" } });
    const row = { fields: fields as Prisma.InputJsonValue, base: base as Prisma.InputJsonValue, local: local as Prisma.InputJsonValue, remote: remote as Prisma.InputJsonValue, remoteVersion: file.version, opId };
    if (open) await this.db.syncConflict.update({ where: { id: open.id }, data: row });
    else await this.db.syncConflict.create({ data: { spaceId, entityType: def.type, entityId: file.id, ...row } });
    this.emit(spaceId, "state");
  }

  /** "mine" keeps this person's values for the conflicting fields; "theirs" takes the remote values. Nothing is dropped silently. */
  async resolveConflict(conflictId: string, choice: "mine" | "theirs"): Promise<void> {
    const c = await this.db.syncConflict.findUniqueOrThrow({ where: { id: conflictId } });
    if (c.status !== "OPEN") return;
    const def = entityDef(c.entityType)!;
    const space = await this.db.space.findUniqueOrThrow({ where: { id: c.spaceId } });
    const ctx = await this.ctx(space);
    const fields = c.fields as string[];
    const remote = c.remote as Data;
    const local = c.local as Data;
    const op = c.opId ? await this.db.outboxOp.findUnique({ where: { id: c.opId } }) : null;
    if (choice === "theirs") {
      const deleted = fields.includes("__deleted") && Object.keys(remote).length === 0;
      await def.apply(this.db, ctx, c.entityId, deleted ? null : remote, c.remoteVersion);
      if (op) await this.db.outboxOp.delete({ where: { id: op.id } });
    } else if (fields.includes("__deleted")) {
      const localGone = Object.keys(local).length === 0;
      if (op) await this.db.outboxOp.update({ where: { id: op.id }, data: localGone ? { kind: "DELETE", data: undefined, status: "PENDING", baseVersion: c.remoteVersion } : { kind: "UPSERT", data: local as Prisma.InputJsonValue, status: "PENDING", baseVersion: c.remoteVersion } });
    } else {
      const merged: Data = { ...remote };
      for (const f of fields) merged[f] = local[f];
      for (const k of Object.keys(local)) if (!fields.includes(k) && !same(local[k], c.base ? (c.base as Data)[k] : undefined)) merged[k] = local[k]; // other local edits survive
      await def.apply(this.db, ctx, c.entityId, merged, c.remoteVersion);
      if (op) await this.db.outboxOp.update({ where: { id: op.id }, data: { data: merged as Prisma.InputJsonValue, status: "PENDING", baseVersion: c.remoteVersion } });
    }
    await this.db.syncConflict.update({ where: { id: c.id }, data: { status: "RESOLVED", resolution: choice, resolvedAt: this.now() } });
    this.emit(c.spaceId, "state");
  }

  // ---------- push ----------

  async pushSpace(space0: Space): Promise<{ sent: number }> {
    if (space0.backend === "HUB") return this.pushHub(space0);
    return this.pushGithub(space0);
  }

  private async pushHub(space0: Space): Promise<{ sent: number }> {
    let space = await this.db.space.findUniqueOrThrow({ where: { id: space0.id } });
    const backend = this.backendOf(space); // throws when no hub client is configured, even for a read-only space
    if (backend.kind !== "hub") throw new Error("Not a hub space");
    const client = backend.client;
    if (!space.canWrite || space.access !== "OK") return { sent: 0 };
    const ctx = await this.ctx(space);
    const keyOf = (type: string, entityId: string) => ({ spaceId_type_entityId: { spaceId: space.id, type, entityId } });
    let sent = 0;
    let touched = false;
    // A stale answer is merged and the rewritten operation is retried at once; the round cap keeps a hot entity from spinning.
    for (let round = 0; round < 3; round++) {
      const ops0 = await this.db.outboxOp.findMany({ where: { spaceId: space.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
      const ops: typeof ops0 = [];
      for (const op of ops0) {
        const se = await this.db.syncEntity.findUnique({ where: keyOf(op.entityType, op.entityId) });
        if (!isBlocked(se)) ops.push(op);
      }
      if (ops.length === 0) break;
      await this.db.outboxOp.updateMany({ where: { id: { in: ops.map((o) => o.id) } }, data: { status: "SENT", attempts: { increment: 1 } } });
      let results: Awaited<ReturnType<HubClient["push"]>>;
      try {
        results = await client.push(space.hubSpaceId, ops.map((o) => ({ opId: o.id, type: o.entityType, entityId: o.entityId, kind: o.kind as "UPSERT" | "DELETE", baseVersion: o.baseVersion, data: o.kind === "DELETE" ? undefined : ((o.data as Data) ?? {}) })));
      } catch (e) {
        // Whether the hub applied them is unknown for network errors: the operation id makes the retry idempotent.
        await this.db.outboxOp.updateMany({ where: { id: { in: ops.map((o) => o.id) }, status: "SENT" }, data: { status: "PENDING", error: e instanceof Error ? e.message : String(e) } });
        await this.handleHubError(space, e, "write");
        return { sent };
      }
      // Access removed while the request was in flight: revokeSpace already quarantined these operations and dropped the
      // space's rows; recording the hub's answers now would re-create them on a space this person can no longer see.
      if (await this.revokedMeanwhile(space.id)) return { sent };
      let rewritten = false;
      try {
      const byId = new Map(results.results.map((r) => [r.opId, r]));
      for (const op of ops) {
        const r = byId.get(op.id);
        const se = await this.db.syncEntity.findUnique({ where: keyOf(op.entityType, op.entityId) });
        const settle = async (version: number) => {
          const applied = [...(((se?.meta as { applied?: string[] } | null)?.applied ?? []).slice(-49)), op.id];
          const row = { path: entityPath(op.entityType, op.entityId), remoteSha: null, baseVersion: version, baseData: ((op.kind === "DELETE" ? {} : op.data) ?? {}) as Prisma.InputJsonValue, meta: { applied } as Prisma.InputJsonValue, deleted: op.kind === "DELETE" };
          await this.db.syncEntity.upsert({ where: keyOf(op.entityType, op.entityId), create: { spaceId: space.id, type: op.entityType, entityId: op.entityId, ...row }, update: row });
        };
        if (!r) {
          await this.db.outboxOp.updateMany({ where: { id: op.id, status: "SENT" }, data: { status: "PENDING" } });
        } else if (r.status === "applied") {
          await settle(r.version);
          await this.db.outboxOp.deleteMany({ where: { id: op.id } });
          sent++;
          touched = true;
        } else if (r.status === "duplicate") {
          if (r.version === (se?.baseVersion ?? 0) + 1) await settle(r.version);
          await this.db.outboxOp.deleteMany({ where: { id: op.id } });
          touched = true;
        } else {
          await this.db.outboxOp.updateMany({ where: { id: op.id, status: "SENT" }, data: { status: "PENDING" } });
          const def = entityDef(op.entityType);
          const current = r.current;
          if (!def) continue;
          if (!current) {
            await this.db.outboxOp.updateMany({ where: { id: op.id }, data: { baseVersion: r.version } });
            rewritten = true;
            continue;
          }
          if (current.schema > ENTITY_SCHEMA) {
            await this.blockEntity(space.id, def.type, current.id, String(results.seq), current.version);
            continue;
          }
          const row = (await this.localMap(def, ctx.commonSpaceId)).get(op.entityId);
          if (row?.spaceId && row.spaceId !== space.id) continue;
          try {
            const m = await this.reconcile(ctx, def, current, String(results.seq), row?.data ?? null);
            if (m.applied && m.data && def.post) await def.post(this.db, ctx, [{ id: op.entityId, data: m.data }]);
          } catch (e) {
            await this.db.outboxOp.updateMany({ where: { id: op.id, status: "PENDING" }, data: { error: e instanceof Error ? e.message : String(e) } });
            continue;
          }
          if (await this.db.outboxOp.count({ where: { id: op.id, status: "PENDING" } })) rewritten = true;
        }
      }
      } catch (e) {
        // A local failure while recording results must not strand operations in SENT: the hub's duplicate answer makes the retry safe.
        await this.db.outboxOp.updateMany({ where: { id: { in: ops.map((o) => o.id) }, status: "SENT" }, data: { status: "PENDING", error: e instanceof Error ? e.message : String(e) } });
        await this.handleHubError(space, e, "write");
        return { sent };
      }
      if (!rewritten) break;
    }
    if (touched) {
      space = await this.db.space.update({ where: { id: space.id }, data: { lastChangedAt: this.now(), lastError: null } });
      this.emit(space.id, "pushed");
    }
    return { sent };
  }

  private async pushGithub(space0: Space): Promise<{ sent: number }> {
    let space = await this.db.space.findUniqueOrThrow({ where: { id: space0.id } });
    if (!space.canWrite || space.access !== "OK") return { sent: 0 };
    const store = this.d.store(space);
    let sent = 0;
    if (this.permissionsStale(space, PUSH_PERMISSION_RECHECK_MS)) {
      try {
        space = await this.refreshPermissions(space, store);
      } catch (e) {
        await this.handleError(space, e, "read");
        return { sent };
      }
      if (!space.canWrite || space.access !== "OK") return { sent };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const ops0 = await this.db.outboxOp.findMany({ where: { spaceId: space.id, status: "PENDING" }, orderBy: { createdAt: "asc" } });
      if (ops0.length === 0) return { sent };
      let head: Head | null | "empty";
      try {
        head = await store.head(space.branch, null);
      } catch (e) {
        await this.handleError(space, e, "write");
        return { sent };
      }
      if (head === null || head === "empty") return { sent };
      if (head.sha !== space.headSha) {
        // Somebody else committed since we last read: merge first, then rebuild our commit on the new head.
        await this.pullSpace({ ...space, etag: null });
        space = await this.db.space.findUniqueOrThrow({ where: { id: space.id } });
        if (space.access !== "OK") return { sent };
        continue;
      }
      // A lost response after a successful commit: the entity file already records our operation id.
      const ops: typeof ops0 = [];
      for (const op of ops0) {
        const se = await this.db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId: space.id, type: op.entityType, entityId: op.entityId } } });
        const applied = ((se?.meta as { applied?: string[] } | null)?.applied ?? []);
        if (applied.includes(op.id)) await this.db.outboxOp.delete({ where: { id: op.id } });
        else if (!isBlocked(se)) ops.push(op);
      }
      if (ops.length === 0) return { sent };

      const files: { path: string; content: string | null }[] = [];
      const perOp: { op: (typeof ops)[number]; version: number; applied: string[] }[] = [];
      const at = this.now().toISOString();
      for (const op of ops) {
        const se = await this.db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId: space.id, type: op.entityType, entityId: op.entityId } } });
        const version = (se?.baseVersion ?? 0) + 1;
        const applied = [...(((se?.meta as { applied?: string[] } | null)?.applied ?? []).slice(-19)), op.id];
        const file: EntityFile = { schema: ENTITY_SCHEMA, type: op.entityType, id: op.entityId, version, deleted: op.kind === "DELETE", appliedOps: applied, updatedAt: at, updatedBy: { id: this.d.actor.id.toString(), login: this.d.actor.login }, data: op.kind === "DELETE" ? {} : ((op.data as Data) ?? {}) };
        files.push({ path: entityPath(op.entityType, op.entityId), content: JSON.stringify(file, null, 2) + "\n" });
        perOp.push({ op, version, applied });
      }
      await this.db.outboxOp.updateMany({ where: { id: { in: ops.map((o) => o.id) } }, data: { status: "SENT", attempts: { increment: 1 } } });
      try {
        const sha = await store.commit(space.branch, { sha: head.sha, treeSha: head.treeSha }, files, `Mergeport: ${ops.length} change(s)\n\n${ops.map((o) => `Mergeport-Op: ${o.id}`).join("\n")}`);
        for (const { op, version, applied } of perOp) {
          const key = { spaceId_type_entityId: { spaceId: space.id, type: op.entityType, entityId: op.entityId } };
          const row = { path: entityPath(op.entityType, op.entityId), remoteSha: null, baseVersion: version, baseData: ((op.kind === "DELETE" ? {} : op.data) ?? {}) as Prisma.InputJsonValue, meta: { applied } as Prisma.InputJsonValue, deleted: op.kind === "DELETE" };
          await this.db.syncEntity.upsert({ where: key, create: { spaceId: space.id, type: op.entityType, entityId: op.entityId, ...row }, update: row });
        }
        await this.db.outboxOp.deleteMany({ where: { id: { in: ops.map((o) => o.id) } } });
        await this.db.space.update({ where: { id: space.id }, data: { headSha: sha, etag: null, lastChangedAt: this.now(), lastError: null } });
        space = await this.db.space.findUniqueOrThrow({ where: { id: space.id } });
        sent += ops.length;
        this.emit(space.id, "pushed");
      } catch (e) {
        // Whether the commit landed is unknown for network errors: go back to PENDING; the operation id makes the retry idempotent.
        await this.db.outboxOp.updateMany({ where: { id: { in: ops.map((o) => o.id) }, status: "SENT" }, data: { status: "PENDING", error: e instanceof Error ? e.message : String(e) } });
        if (e instanceof HeadMovedError) continue;
        await this.handleError(space, e, "write");
        return { sent };
      }
    }
    return { sent };
  }

  // ---------- full cycle, polling ----------

  async syncSpace(space: Space): Promise<void> {
    if (this.syncing.has(space.id)) return; // never two cycles for one space in one process
    this.syncing.add(space.id);
    this.emit(space.id, "state");
    try {
      await this.pullSpace(space);
      await this.capture();
      const fresh = await this.db.space.findUniqueOrThrow({ where: { id: space.id } });
      await this.pushSpace(fresh);
    } finally {
      this.syncing.delete(space.id);
      this.emit(space.id, "state");
    }
  }

  /** Polls every space that is due. Safe to call often. */
  async tick(): Promise<{ polled: number }> {
    const now = this.now();
    const spaces = await this.db.space.findMany({ where: { OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] } });
    let polled = 0;
    for (const s of spaces) {
      if (s.backend === "HUB" && this.d.hubLive?.()) continue; // the live stream drives hub spaces
      if (s.rateLimitedUntil && s.rateLimitedUntil > now) continue;
      if (s.access === "REVOKED" || s.access === "SCHEMA_NEWER") {
        if (s.lastPolledAt && now.getTime() - s.lastPolledAt.getTime() < REVOKED_RECHECK_MS) continue;
      }
      try {
        await this.syncSpace(s);
      } catch (e) {
        await this.handleError(s, e, "read").catch(() => {});
        await this.schedule(s, "error").catch(() => {});
      }
      polled++;
    }
    return { polled };
  }

  async refreshNow(spaceId?: string): Promise<void> {
    const spaces = spaceId ? await this.db.space.findMany({ where: { id: spaceId } }) : await this.db.space.findMany();
    for (const s of spaces) await this.syncSpace({ ...s, etag: null, rateLimitedUntil: null });
  }

  private async schedule(space: Space, outcome: "changed" | "unchanged" | "error", retryAfterMs?: number): Promise<void> {
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    const base = space.backend === "HUB" ? (this.d.hubLive?.() ? MAX_POLL_MS : 60_000) : Math.max(15, team?.pollSeconds ?? 30) * 1000;
    let interval: number;
    let unchanged = space.unchangedPolls;
    if (outcome === "changed") {
      interval = base;
      unchanged = 0;
    } else if (outcome === "unchanged") {
      unchanged++;
      interval = Math.min(base * 2 ** Math.floor(unchanged / 4), MAX_POLL_MS);
    } else interval = retryAfterMs ?? Math.min(Math.max(space.pollIntervalMs, base) * 2, MAX_POLL_MS);
    const jittered = Math.round(interval * (0.8 + this.random() * 0.4));
    const now = this.now();
    await this.db.space.update({ where: { id: space.id }, data: { pollIntervalMs: interval, unchangedPolls: unchanged, lastPolledAt: now, nextPollAt: new Date(now.getTime() + jittered) } });
  }

  // ---------- access, errors, revocation ----------

  private async refreshPermissions(space: Space, store: CoordinationStore): Promise<Space> {
    const info = await store.info();
    if (!info.private) {
      return this.db.space.update({ where: { id: space.id }, data: { access: "NO_ACCESS", lastError: "This repository is public. Coordination spaces must be private." } });
    }
    if (!info.permissions.pull) throw new GithubError("forbidden", "No read access", undefined, undefined, 403);
    if (space.repoGithubId !== null && BigInt(info.id) !== space.repoGithubId) {
      return this.db.space.update({ where: { id: space.id }, data: { access: "NO_ACCESS", canWrite: false, canAdmin: false, lastError: "This repository was deleted and recreated, or replaced. Join it again deliberately if you trust it." } });
    }
    this.permAt.set(space.id, this.now().getTime());
    return this.db.space.update({ where: { id: space.id }, data: { canWrite: info.permissions.push || info.permissions.admin, canAdmin: info.permissions.admin, repoGithubId: BigInt(info.id), access: space.access === "REVOKED" ? "OK" : space.access } });
  }

  private async handleError(space: Space, e: unknown, phase: "read" | "write"): Promise<void> {
    if (!(e instanceof GithubError)) {
      await this.db.space.update({ where: { id: space.id }, data: { lastError: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const now = this.now();
    if (e.kind === "rate-limited") {
      const until = e.resetAt ?? new Date(now.getTime() + (e.retryAfterSeconds ?? 60) * 1000);
      await this.db.space.update({ where: { id: space.id }, data: { rateLimitedUntil: until, lastError: "GitHub rate limit reached. Edits stay queued locally.", nextPollAt: until } });
    } else if (e.kind === "network") {
      await this.schedule(space, "error");
      await this.db.space.update({ where: { id: space.id }, data: { lastError: "offline" } });
    } else if (e.kind === "not-found" || e.kind === "forbidden") {
      if (phase === "write" && e.kind === "forbidden") {
        // Lost write permission but maybe still readable: fall back to read-only and keep the edits for a person to decide on.
        const s = await this.db.space.update({ where: { id: space.id }, data: { canWrite: false, lastError: "You no longer have write access to this space." } });
        await this.db.outboxOp.updateMany({ where: { spaceId: space.id, status: { in: ["PENDING", "SENT"] } }, data: { status: "QUARANTINED", error: "Write access was removed" } });
        void s;
      } else await this.revokeSpace(space.id, "Access to this coordination repository was removed");
    } else if (e.kind === "auth") {
      await this.db.space.update({ where: { id: space.id }, data: { lastError: "Your GitHub sign-in (gh) is no longer valid. Run gh auth login." } });
    } else await this.schedule(space, "error");
    this.emit(space.id, "state");
  }

  /** True when the space lost access (revokeSpace ran) since the caller last read it: a pull or push in flight must stop. */
  private async revokedMeanwhile(spaceId: string): Promise<boolean> {
    const s = await this.db.space.findUnique({ where: { id: spaceId }, select: { access: true } });
    return !s || s.access === "REVOKED";
  }

  private async handleHubError(space: Space, e: unknown, phase: "read" | "write"): Promise<void> {
    if (!(e instanceof HubError)) {
      await this.schedule(space, "error");
      await this.db.space.update({ where: { id: space.id }, data: { lastError: e instanceof Error ? e.message : String(e) } });
      return;
    }
    const now = this.now();
    if (e.kind === "network") {
      await this.schedule(space, "error");
      await this.db.space.update({ where: { id: space.id }, data: { lastError: "offline" } });
    } else if (e.kind === "auth") {
      await this.schedule(space, "error");
      await this.db.space.update({ where: { id: space.id }, data: { lastError: "Sign in to the server again" } });
    } else if (e.kind === "not-found" || (e.kind === "forbidden" && phase === "read")) {
      await this.revokeSpace(space.id, "Access to this space was removed");
    } else if (e.kind === "forbidden") {
      // Lost write permission but maybe still readable: fall back to read-only and keep the edits for a person to decide on.
      await this.db.space.update({ where: { id: space.id }, data: { canWrite: false, lastError: "You no longer have write access to this space." } });
      await this.db.outboxOp.updateMany({ where: { spaceId: space.id, status: { in: ["PENDING", "SENT"] } }, data: { status: "QUARANTINED", error: "Write access was removed" } });
    } else if (e.kind === "rate-limited") {
      const until = new Date(now.getTime() + (e.retryAfterSeconds ?? 60) * 1000);
      await this.db.space.update({ where: { id: space.id }, data: { rateLimitedUntil: until, lastError: "The server asked to slow down. Edits stay queued locally.", nextPollAt: until } });
    } else {
      await this.schedule(space, "error");
      await this.db.space.update({ where: { id: space.id }, data: { lastError: e.message } });
    }
    this.emit(space.id, "state");
  }

  /**
   * Stop reads and writes, quarantine unsent edits (kept, not deleted), and remove cached copies of the space's data
   * from this machine. This cannot erase Git history or anything a person downloaded outside the app.
   */
  async revokeSpace(spaceId: string, why: string): Promise<void> {
    const space = await this.db.space.findUniqueOrThrow({ where: { id: spaceId } });
    await this.db.space.update({ where: { id: spaceId }, data: { access: "REVOKED", canWrite: false, canAdmin: false, lastError: why, headSha: null, etag: null, hubCursor: 0n, nextPollAt: new Date(this.now().getTime() + REVOKED_RECHECK_MS) } });
    await this.db.outboxOp.updateMany({ where: { spaceId, status: { in: ["PENDING", "SENT", "CONFLICT"] } }, data: { status: "QUARANTINED", error: why } });
    if (space.canAdmin) {
      // An admin created this data on this computer. A repository that was renamed, deleted or hidden must never erase their
      // projects, cards and rules: they become local again, and can be shared into a new space.
      await this.db.repository.updateMany({ where: { spaceId }, data: { spaceId: null } });
      await this.db.project.updateMany({ where: { spaceId }, data: { spaceId: null } });
    } else {
      const ctx = await this.ctx(space);
      const entities = await this.db.syncEntity.findMany({ where: { spaceId } });
      for (const def of [...ENTITY_TYPES].reverse()) {
        if (def.type === "repo") continue;
        for (const se of entities.filter((e) => e.type === def.type)) await def.apply(this.db, ctx, se.entityId, null, se.baseVersion).catch(() => {});
      }
      // Repositories last: removing them cascades their cached issues, pull requests and comments.
      await this.db.repository.deleteMany({ where: { spaceId } });
    }
    await this.db.syncEntity.deleteMany({ where: { spaceId } });
    await this.db.syncConflict.updateMany({ where: { spaceId, status: "OPEN" }, data: { status: "RESOLVED", resolution: "access-revoked", resolvedAt: this.now() } });
    await this.refreshRole();
    this.emit(spaceId, "state");
  }

  /** After access returns, quarantined edits are NOT sent automatically. */
  async releaseQuarantine(spaceId: string, action: "retry" | "discard"): Promise<void> {
    if (action === "discard") {
      const space = await this.db.space.findUniqueOrThrow({ where: { id: spaceId } });
      const ctx = await this.ctx(space);
      for (const op of await this.db.outboxOp.findMany({ where: { spaceId, status: "QUARANTINED" } })) {
        const def = entityDef(op.entityType);
        const se = await this.db.syncEntity.findUnique({ where: { spaceId_type_entityId: { spaceId, type: op.entityType, entityId: op.entityId } } });
        // Put the local copy back to what the space last agreed on, so the discarded edit is not captured again.
        if (def) await def.apply(this.db, ctx, op.entityId, se && !se.deleted ? (se.baseData as Data) : null, se?.baseVersion ?? 0).catch(() => {});
      }
      await this.db.outboxOp.deleteMany({ where: { spaceId, status: "QUARANTINED" } });
    } else await this.db.outboxOp.updateMany({ where: { spaceId, status: "QUARANTINED" }, data: { status: "PENDING", error: null } });
    this.emit(spaceId, "state");
  }

  /** Role comes from GitHub permissions on the common space, never from a field anyone can edit. */
  async refreshRole(): Promise<void> {
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    if (!team || team.mode === "PERSONAL") return;
    const common = team.commonSpaceId ? await this.db.space.findUnique({ where: { id: team.commonSpaceId } }) : null;
    const admin = !!common && common.access === "OK" && common.canAdmin;
    await this.db.member.updateMany({ where: { status: "ACTIVE" }, data: { role: admin ? "ADMIN" : "MEMBER" } });
  }

  // ---------- state for the interface ----------

  async stateFor(space: Space): Promise<{ state: SpaceState; pending: number; conflicts: number; detail: string | null }> {
    const [pending, conflicts] = await Promise.all([
      this.db.outboxOp.count({ where: { spaceId: space.id, status: { in: ["PENDING", "SENT"] } } }),
      this.db.syncConflict.count({ where: { spaceId: space.id, status: "OPEN" } }),
    ]);
    const now = this.now();
    let state: SpaceState = "synced";
    if (space.access === "REVOKED") state = "revoked";
    else if (space.access === "SCHEMA_NEWER") state = "schema";
    else if (space.rateLimitedUntil && space.rateLimitedUntil > now) state = "rate-limited";
    else if (space.lastError === "offline") state = "offline";
    else if (this.syncing.has(space.id)) state = "syncing";
    else if (conflicts > 0) state = "conflict";
    else if (pending > 0) state = "pending";
    else if (!space.canWrite) state = "read-only";
    return { state, pending, conflicts, detail: space.lastError === "offline" ? null : space.lastError };
  }
}

/** Expected delay before a teammate's change shows up here, in seconds. This is polling, not real time. */
export function expectedConsistencyDelaySeconds(pollSeconds: number, hub?: { live: boolean }): { typical: number; worst: number; label?: string } {
  if (hub) return hub.live ? { typical: 1, worst: 1, label: "about 1 s (live)" } : { typical: 30, worst: 60, label: "up to 1 min (reconnecting)" };
  return { typical: Math.round(pollSeconds / 2 + 2), worst: Math.round(Math.min(MAX_POLL_MS / 1000, pollSeconds * 2 ** 3) * 1.2) };
}
