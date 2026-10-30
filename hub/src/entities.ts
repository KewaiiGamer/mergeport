import { z } from "zod";
import { getMember, requireSession } from "./auth";
import { spaceAccess, type SpaceAccess } from "./authz";
import type { HubDb } from "./db";
import { HttpError, json, readJson, route, type Route } from "./http";
import type { HubContext } from "./server";

const iso = (ms: number) => new Date(ms).toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 30 * DAY_MS;
const APPLIED_OPS_KEEP = 50;
const MAX_OPS = 500;
const MAX_DATA_BYTES = 256 * 1024;
/** Request body cap (413 beyond); the per-op zod limits still apply inside it. */
const OPS_BODY_LIMIT = 16 * 1024 * 1024;

export type Op = { opId: string; type: string; entityId: string; kind: "UPSERT" | "DELETE"; baseVersion: number; data?: Record<string, unknown> };
export type EntityJson = {
  schema: 1;
  type: string;
  id: string;
  version: number;
  deleted: boolean;
  appliedOps: string[];
  updatedAt: string;
  updatedBy: { id: string; login: string };
  data: Record<string, unknown>;
};
export type OpResult = { opId: string; status: "applied" | "duplicate" | "stale"; version: number; current?: EntityJson };
export type EventJson = EntityJson & { seq: string; opId: string };

const q = (db: HubDb, sql: string) => db.prepare(sql).safeIntegers(true);

type EntityRow = {
  type: string;
  entity_id: string;
  version: bigint;
  deleted: bigint;
  data: string;
  applied_ops: string;
  updated_at: string;
  updated_by: bigint;
  login: string | null;
};

const entityJson = (r: EntityRow): EntityJson => ({
  schema: 1,
  type: r.type,
  id: r.entity_id,
  version: Number(r.version),
  deleted: r.deleted === 1n,
  appliedOps: JSON.parse(r.applied_ops) as string[],
  updatedAt: r.updated_at,
  updatedBy: { id: r.updated_by.toString(), login: r.login ?? "" },
  data: JSON.parse(r.data) as Record<string, unknown>,
});

const ENTITY_SELECT = `SELECT e.type, e.entity_id, e.version, e.deleted, e.data, e.applied_ops, e.updated_at, e.updated_by, m.login
  FROM entity e LEFT JOIN member m ON m.github_id = e.updated_by`;

/** Applies ops in order inside one transaction; the caller notifies after this returns (committed). */
export function applyOps(db: HubDb, spaceId: string, actor: { githubId: bigint; login: string }, ops: Op[], now: number): { results: OpResult[]; seq: bigint } {
  const at = iso(now);
  const getEntity = q(db, `${ENTITY_SELECT} WHERE e.space_id = ? AND e.type = ? AND e.entity_id = ?`);
  const dupEvent = q(db, "SELECT 1 FROM entity_event WHERE space_id = ? AND type = ? AND entity_id = ? AND op_id = ? LIMIT 1");
  const putEntity = db.prepare(
    `INSERT INTO entity (space_id, type, entity_id, version, deleted, data, applied_ops, updated_at, updated_by, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (space_id, type, entity_id) DO UPDATE SET version = excluded.version, deleted = excluded.deleted, data = excluded.data, applied_ops = excluded.applied_ops,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by, seq = excluded.seq`,
  );
  const bump = q(db, "UPDATE space SET seq = seq + 1 WHERE id = ?");
  const readSeq = q(db, "SELECT seq FROM space WHERE id = ?");
  const putEvent = db.prepare(
    "INSERT INTO entity_event (space_id, seq, type, entity_id, version, deleted, data, op_id, actor_github_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  return db.transaction((): { results: OpResult[]; seq: bigint } => {
    // The route authorized before it awaited the body; a removal or demotion may have committed since. SQLite serializes writers,
    // so what this transaction reads is what stays true until it commits: no event is ever written for a member who no longer may write.
    const current = getMember(db, actor.githubId);
    if (!current || !spaceAccess(db, current, spaceId).canWrite) throw new HttpError(403, "forbidden");
    const results: OpResult[] = [];
    for (const op of ops) {
      const row = getEntity.get(spaceId, op.type, op.entityId) as EntityRow | undefined;
      const applied = row ? (JSON.parse(row.applied_ops) as string[]) : [];
      const version = row ? Number(row.version) : 0;
      if (applied.includes(op.opId) || dupEvent.get(spaceId, op.type, op.entityId, op.opId)) {
        results.push({ opId: op.opId, status: "duplicate", version });
        continue;
      }
      if (op.baseVersion !== version) {
        results.push({ opId: op.opId, status: "stale", version, ...(row ? { current: entityJson(row) } : {}) });
        continue;
      }
      const deleted = op.kind === "DELETE";
      const data = JSON.stringify(deleted ? {} : (op.data ?? {}));
      const next = version + 1;
      bump.run(spaceId);
      const seq = (readSeq.get(spaceId) as { seq: bigint }).seq;
      putEntity.run(spaceId, op.type, op.entityId, next, deleted ? 1 : 0, data, JSON.stringify([...applied, op.opId].slice(-APPLIED_OPS_KEEP)), at, actor.githubId, seq);
      putEvent.run(spaceId, seq, op.type, op.entityId, next, deleted ? 1 : 0, data, op.opId, actor.githubId, at);
      results.push({ opId: op.opId, status: "applied", version: next });
    }
    const seq = (readSeq.get(spaceId) as { seq: bigint } | undefined)?.seq ?? 0n;
    return { results, seq };
  }).immediate();
}

function currentSeq(db: HubDb, spaceId: string): bigint {
  return ((q(db, "SELECT seq FROM space WHERE id = ?").get(spaceId) as { seq: bigint } | undefined)?.seq) ?? 0n;
}

/** Highest seq that is no longer available (everything above it is still in the log). */
function minRetainedSeq(db: HubDb, spaceId: string, spaceSeq: bigint): bigint {
  const r = q(db, "SELECT MIN(seq) AS m FROM entity_event WHERE space_id = ?").get(spaceId) as { m: bigint | null };
  return r.m === null ? spaceSeq : r.m - 1n;
}

/** The op that produced the event at `seq` ("" when there is none: seq 0, or an event already pruned). */
function opAt(db: HubDb, spaceId: string, seq: bigint): string {
  if (seq <= 0n) return "";
  const r = db.prepare("SELECT op_id FROM entity_event WHERE space_id = ? AND seq = ?").get(spaceId, seq) as { op_id: string | null } | undefined;
  return r?.op_id ?? "";
}

/**
 * `after` is the op the client last read at `since`. If this log holds a different op at that position, the client's history is not a prefix
 * of ours (the hub was restored from a backup and then moved on): events cannot reconcile it, only a snapshot plus the client's own decision.
 */
export function eventsSince(db: HubDb, spaceId: string, since: bigint, limit = 500, after?: string): { seq: bigint; seqOp: string; events: EventJson[]; more: boolean } | "gone" | "history" {
  const spaceSeq = currentSeq(db, spaceId);
  if (since < minRetainedSeq(db, spaceId, spaceSeq) && since < spaceSeq) return "gone";
  if (after) {
    const here = opAt(db, spaceId, since);
    if (here && here !== after) return "history";
  }
  const rows = q(
    db,
    `SELECT ev.seq, ev.type, ev.entity_id, ev.version, ev.deleted, ev.data, ev.op_id, ev.actor_github_id, ev.at, m.login
     FROM entity_event ev LEFT JOIN member m ON m.github_id = ev.actor_github_id
     WHERE ev.space_id = ? AND ev.seq > ? ORDER BY ev.seq LIMIT ?`,
  ).all(spaceId, since, limit + 1) as (Omit<EntityRow, "applied_ops" | "updated_at" | "updated_by"> & { seq: bigint; op_id: string | null; actor_github_id: bigint; at: string })[];
  const more = rows.length > limit;
  const events: EventJson[] = rows.slice(0, limit).map((r) => ({
    ...entityJson({ ...r, applied_ops: JSON.stringify(r.op_id ? [r.op_id] : []), updated_at: r.at, updated_by: r.actor_github_id }),
    seq: r.seq.toString(),
    opId: r.op_id ?? "",
  }));
  const seq = more ? BigInt(events[events.length - 1].seq) : spaceSeq;
  return { seq, seqOp: more ? events[events.length - 1].opId : opAt(db, spaceId, seq), events, more };
}

export function snapshot(db: HubDb, spaceId: string): { seq: bigint; seqOp: string; entities: EntityJson[] } {
  return db.transaction(() => {
    const rows = q(db, `${ENTITY_SELECT} WHERE e.space_id = ? ORDER BY e.type, e.entity_id`).all(spaceId) as EntityRow[];
    const seq = currentSeq(db, spaceId);
    return { seq, seqOp: opAt(db, spaceId, seq), entities: rows.map(entityJson) };
  })();
}

/** Records how far this session has read: never moves backwards, never beyond the space's seq. */
function recordCursor(db: HubDb, idHash: string, spaceId: string, since: bigint): void {
  const row = db.prepare("SELECT cursor_json FROM session WHERE id_hash = ?").get(idHash) as { cursor_json: string | null } | undefined;
  if (!row) return;
  let cursors: Record<string, string> = {};
  try {
    const parsed: unknown = row.cursor_json ? JSON.parse(row.cursor_json) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cursors = parsed as Record<string, string>;
  } catch {
    /* corrupt cursor: start over */
  }
  const capped = since < currentSeq(db, spaceId) ? since : currentSeq(db, spaceId);
  let prev = 0n;
  try {
    prev = BigInt(cursors[spaceId] ?? "0");
  } catch {
    /* ignore */
  }
  if (capped <= prev && spaceId in cursors) return;
  cursors[spaceId] = (capped > prev ? capped : prev).toString();
  db.prepare("UPDATE session SET cursor_json = ? WHERE id_hash = ?").run(JSON.stringify(cursors), idHash);
}

/** Deletes events older than 30 days that every active session with a cursor for the space has already read. */
export function prune(db: HubDb, now: number): number {
  return db.transaction(() => {
    const cutoff = iso(now - EVENT_RETENTION_MS);
    const mins = new Map<string, bigint>();
    const sessions = db.prepare("SELECT cursor_json FROM session WHERE expires_at > ? AND cursor_json IS NOT NULL").all(iso(now)) as { cursor_json: string }[];
    for (const s of sessions) {
      let cursors: unknown;
      try {
        cursors = JSON.parse(s.cursor_json);
      } catch {
        continue;
      }
      if (!cursors || typeof cursors !== "object") continue;
      for (const [space, v] of Object.entries(cursors as Record<string, unknown>)) {
        let n: bigint;
        try {
          n = BigInt(String(v));
        } catch {
          continue;
        }
        const cur = mins.get(space);
        if (cur === undefined || n < cur) mins.set(space, n);
      }
    }
    const spaces = db.prepare("SELECT DISTINCT space_id FROM entity_event WHERE at < ?").all(cutoff) as { space_id: string }[];
    const del = db.prepare("DELETE FROM entity_event WHERE space_id = ? AND at < ? AND seq <= ?");
    let removed = 0;
    for (const { space_id } of spaces) {
      const min = mins.get(space_id);
      // No active session has a cursor here: nothing is waiting on the log (clients without a cursor start from a snapshot).
      removed += del.run(space_id, cutoff, min ?? 9223372036854775807n).changes;
    }
    return removed;
  })();
}

/** Called after every committed ops request that changed a space: queues the WebSocket `changed` notification. */
export function entitiesChanged(ctx: HubContext, spaceId: string, seq: bigint): void {
  ctx.log.info("entities changed", { spaceId, seq: seq.toString() });
  ctx.notify.changed(spaceId, seq);
}

const opSchema = z.object({
  opId: z.string().min(1).max(128),
  type: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  entityId: z.string().min(1).max(128),
  kind: z.enum(["UPSERT", "DELETE"]),
  baseVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  data: z
    .record(z.string(), z.unknown())
    .refine((d) => Buffer.byteLength(JSON.stringify(d)) <= MAX_DATA_BYTES, "data too large")
    .optional(),
});
const opsBody = z.object({ ops: z.array(opSchema).max(MAX_OPS) });

const SINCE = /^[0-9]{1,18}$/;

export function entityRoutes(): Route<HubContext>[] {
  /** 404 for unknown spaces and for spaces the member cannot read, so existence is not revealed. */
  const access = (ctx: HubContext, req: import("node:http").IncomingMessage, spaceId: string) => {
    const s = requireSession(ctx, req);
    const a: SpaceAccess = spaceAccess(ctx.db, s.member, spaceId);
    if (!a.canRead) throw new HttpError(404, "space not found");
    return { session: s, access: a };
  };

  return [
    route<HubContext>("GET", "/spaces/:id/entities", (ctx, req, res, params, url) => {
      const { session } = access(ctx, req, params.id);
      const rawSince = url.searchParams.get("since") ?? "0";
      if (!SINCE.test(rawSince)) throw new HttpError(400, "invalid since");
      const rawLimit = url.searchParams.get("limit");
      let limit = 500;
      if (rawLimit !== null) {
        if (!/^[0-9]{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500) throw new HttpError(400, "invalid limit");
        limit = Number(rawLimit);
      }
      const rawAfter = url.searchParams.get("after") ?? "";
      if (rawAfter.length > 128) throw new HttpError(400, "invalid after");
      const since = BigInt(rawSince);
      const r = eventsSince(ctx.db, params.id, since, limit, rawAfter || undefined);
      if (r === "gone") return json(res, 410, { error: "gone" });
      if (r === "history") return json(res, 410, { error: "gone", reason: "history" });
      recordCursor(ctx.db, session.idHash, params.id, since);
      json(res, 200, { epoch: ctx.epoch, seq: r.seq.toString(), seqOp: r.seqOp, events: r.events, more: r.more });
    }),

    route<HubContext>("GET", "/spaces/:id/snapshot", (ctx, req, res, params) => {
      access(ctx, req, params.id);
      const s = snapshot(ctx.db, params.id);
      json(res, 200, { epoch: ctx.epoch, seq: s.seq.toString(), seqOp: s.seqOp, entities: s.entities });
    }),

    route<HubContext>("POST", "/spaces/:id/ops", async (ctx, req, res, params) => {
      const { session, access: a } = access(ctx, req, params.id);
      if (!a.canWrite) throw new HttpError(403, "forbidden");
      const body = await readJson(req, opsBody, OPS_BODY_LIMIT);
      const r = applyOps(ctx.db, params.id, { githubId: session.member.githubId, login: session.member.login }, body.ops as Op[], ctx.now());
      if (r.results.some((x) => x.status === "applied")) entitiesChanged(ctx, params.id, r.seq);
      json(res, 200, { results: r.results, seq: r.seq.toString() });
    }),
  ];
}

export function startPruneTimer(ctx: Pick<HubContext, "db" | "now" | "log">, everyMs = 10 * 60 * 1000): () => void {
  const run = () => {
    try {
      const n = prune(ctx.db, ctx.now());
      if (n > 0) ctx.log.info("pruned events", { removed: n });
    } catch (e) {
      ctx.log.error("prune failed", { error: e instanceof Error ? e.message : "unknown error" });
    }
  };
  run();
  const t = setInterval(run, everyMs);
  t.unref();
  return () => clearInterval(t);
}
