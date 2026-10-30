import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Space } from "@/generated/prisma/client";
import { createPrisma, type Db } from "@/lib/db";
import { HttpHubClient } from "@/lib/hub/client";
import type { SocketLike } from "@/lib/hub/link";
import { startHubLive } from "@/lib/hub/live";
import { syncHubSpaces } from "@/lib/hub/spaces";
import { HubError, type Op } from "@/lib/hub/types";
import { ensureLocalProfile } from "@/lib/local/profile";
import { createColumnsForProject } from "@/lib/services/planning";
import { SyncEngine } from "@/lib/sync/engine";
import { signInAs, startTestHub, type TestHub } from "./hub/harness";
import { cardData } from "./hub-client/harness";

/**
 * Two local Mergeport clients against the real in-process hub (hub/src, started by tests/hub/harness.ts), real
 * WebSockets and real timers: nothing of the hub is faked except GitHub's OAuth endpoints.
 */

/** Node's global WebSocket behind the engine's SocketLike; `closeCode` records how the hub ended it. */
class NodeSocket implements SocketLike {
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  closeCode: number | null = null;
  readonly closed: Promise<number>;
  private readonly ws: WebSocket;
  constructor(url: string, protocols: string[]) {
    this.ws = new WebSocket(url, protocols);
    this.closed = new Promise<number>((resolve) => {
      this.ws.addEventListener("close", (e) => {
        this.closeCode = e.code;
        resolve(e.code);
        this.onclose?.({ code: e.code });
      });
    });
    this.ws.addEventListener("open", () => this.onopen?.());
    this.ws.addEventListener("message", (e) => this.onmessage?.({ data: String(e.data) }));
    this.ws.addEventListener("error", () => this.onerror?.());
  }
  send(data: string) {
    this.ws.send(data);
  }
  close(code?: number) {
    this.ws.close(code);
  }
}

let hub: TestHub;
let counter = 0;
type Client = Awaited<ReturnType<typeof makeClient>>;
const open: { close(): Promise<void> }[] = [];

async function makeClient(githubId: bigint, login: string, token: string) {
  const file = path.resolve(".data", `client-e2e-${login}-${process.pid}-${counter++}.db`);
  for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(file + sfx, { force: true });
  const db: Db = createPrisma(file);
  const profile = await ensureLocalProfile(db, { id: githubId, login, name: login, avatarUrl: null, host: "github.com" });
  const origin = hub.url;
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "HUB", hubOrigin: origin }, update: { mode: "TEAM", backend: "HUB", hubOrigin: origin } });
  const client = new HttpHubClient(origin, async () => token);
  const sockets: NodeSocket[] = [];
  let live: ReturnType<typeof startHubLive> | null = null;
  const engine = new SyncEngine({
    db,
    actor: { id: githubId, login },
    store: () => {
      throw new Error("GitHub store used in a hub test");
    },
    hub: () => client,
    hubLive: () => live?.live() ?? false,
  });
  live = startHubLive({
    db, engine, client, origin, getToken: async () => token,
    connect: (url, protocols) => {
      const s = new NodeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
  });
  const space = (hubSpaceId: string): Promise<Space> => db.space.findFirstOrThrow({ where: { backend: "HUB", hubSpaceId } });
  const sync = async () => {
    await syncHubSpaces(db, engine, await client.me(), origin);
    for (const s of await db.space.findMany({ where: { backend: "HUB", access: { not: "REVOKED" } } })) await engine.syncSpace(s);
  };
  const c = {
    login, db, profile, client, engine, live, sockets, space, sync,
    close: async () => {
      live?.stop();
      await db.$disconnect();
    },
  };
  open.push(c);
  await vi.waitFor(() => expect(live!.live()).toBe(true), { timeout: 3000 });
  await vi.waitFor(async () => expect(await db.space.count({ where: { backend: "HUB" } })).toBeGreaterThan(0), { timeout: 3000 });
  return c;
}

let ownerToken: string;
let olive: Client;
let alice: Client;

beforeEach(async () => {
  hub = await startTestHub();
  ownerToken = await signInAs(hub, 1n, "olive");
  hub.github.addUser({ id: 2n, login: "alice" });
  const invite = await hub.api(ownerToken)("POST", "/admin/invites", { githubLogin: "alice", role: "MEMBER" });
  expect(invite.status).toBe(201);
  const aliceToken = await signInAs(hub, 2n, "alice");
  olive = await makeClient(1n, "olive", ownerToken);
  alice = await makeClient(2n, "alice", aliceToken);
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await hub.close();
});

const hubVersion = (spaceId: string, type: string, id: string) => (hub.db.prepare("SELECT version FROM entity WHERE space_id = ? AND type = ? AND entity_id = ?").get(spaceId, type, id) as { version: number } | undefined)?.version;

async function makeProject(c: Client, id: string, name: string, spaceId: string) {
  const p = await c.db.project.create({ data: { id, workspaceId: c.profile.workspace.id, name, slug: `${name.toLowerCase()}-${counter++}`, spaceId } });
  await createColumnsForProject(c.db, p.id);
  return p;
}
async function makeCard(c: Client, projectId: string, id: string, title: string) {
  const col = await c.db.planningColumn.findFirstOrThrow({ where: { projectId, key: "ready" } });
  return c.db.planningItem.create({ data: { id, projectId, columnId: col.id, position: 1024, title, createdById: c.profile.member.id } });
}
const title = async (c: Client, id: string) => (await c.db.planningItem.findUnique({ where: { id } }))?.title;

/** A board on olive, pushed and pulled on both sides. */
async function seedBoard() {
  const sp = await olive.space("common");
  await makeProject(olive, "p1", "Atlas", sp.id);
  await makeCard(olive, "p1", "c1", "One");
  await makeCard(olive, "p1", "c2", "Two");
  await olive.sync();
  await vi.waitFor(async () => expect(await title(alice, "c2")).toBe("Two"), { timeout: 3000 });
  await alice.sync();
}

describe("two clients against the real hub", () => {
  it("a project created by olive appears in alice's database within 1 s of syncSpace", async () => {
    const sp = await olive.space("common");
    await makeProject(olive, "p1", "Atlas", sp.id);
    await olive.engine.syncSpace(sp);
    const t0 = Date.now();
    await vi.waitFor(async () => expect((await alice.db.project.findUnique({ where: { id: "p1" } }))?.name).toBe("Atlas"), { timeout: 1000, interval: 10 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hubVersion("common", "project", "p1")).toBe(1);
  });

  it("concurrent edits to two different cards both land with no conflict", async () => {
    await seedBoard();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "O1" } });
    await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: "A2" } });
    await Promise.all([olive.engine.syncSpace(await olive.space("common")), alice.engine.syncSpace(await alice.space("common"))]);
    await vi.waitFor(async () => {
      expect(await title(olive, "c2")).toBe("A2");
      expect(await title(alice, "c1")).toBe("O1");
    }, { timeout: 3000 });
    expect(hubVersion("common", "card", "c1")).toBe(2);
    expect(hubVersion("common", "card", "c2")).toBe(2);
    expect(await olive.db.syncConflict.count()).toBe(0);
    expect(await alice.db.syncConflict.count()).toBe(0);
    expect(await olive.db.outboxOp.count({ where: { status: { not: "SENT" } } })).toBe(0);
    expect(await alice.db.outboxOp.count({ where: { status: { not: "SENT" } } })).toBe(0);
  });

  it("the same field edited on both sides: one stale answer, then a SyncConflict row", async () => {
    await seedBoard();
    // alice's edit is captured first, so her op carries the old base version; olive's lands on the hub before it is sent.
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Alice" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Olive" } });
    await olive.engine.syncSpace(await olive.space("common"));
    const statuses: string[] = [];
    const push = alice.client.push.bind(alice.client);
    vi.spyOn(alice.client, "push").mockImplementation(async (spaceId, ops) => {
      const r = await push(spaceId, ops);
      statuses.push(...r.results.map((x) => x.status));
      return r;
    });
    await alice.engine.pushSpace(await alice.space("common"));
    expect(statuses).toEqual(["stale"]);
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["title"]);
    expect((await alice.db.outboxOp.findFirstOrThrow({ where: { entityId: "c1" } })).status).toBe("CONFLICT");
    expect(hubVersion("common", "card", "c1")).toBe(2);
  });

  it("a duplicate retry of the same op id applies once", async () => {
    await seedBoard();
    const op: Op = { opId: "op-dup-1", type: "card", entityId: "c1", kind: "UPSERT", baseVersion: 1, data: cardData("p1", "Dup") };
    const first = await olive.client.push("common", [op]);
    expect(first.results[0]).toMatchObject({ opId: "op-dup-1", status: "applied", version: 2 });
    const again = await olive.client.push("common", [op]);
    expect(again.results[0]).toMatchObject({ opId: "op-dup-1", status: "duplicate", version: 2 });
    expect(hubVersion("common", "card", "c1")).toBe(2);
    expect(again.seq).toBe(first.seq);
  });

  it("after the owner removes alice her socket closes with 4403, her spaces are REVOKED and unsent ops QUARANTINED", async () => {
    await seedBoard();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Unsent" } });
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
    const sock = alice.sockets.at(-1)!;
    const removed = await hub.api(ownerToken)("DELETE", "/admin/members/2");
    expect(removed.status).toBe(204);
    expect(await sock.closed).toBe(4403);
    await vi.waitFor(async () => expect((await alice.space("common")).access).toBe("REVOKED"), { timeout: 3000 });
    expect(alice.live!.link.state).toBe("removed");
    expect((await alice.db.outboxOp.findMany()).map((o) => o.status)).toEqual(["QUARANTINED"]);
    expect(await alice.db.project.count()).toBe(0);
    expect(await alice.db.planningItem.count()).toBe(0);
    // the hub revoked her sessions on removal (admin-routes.ts), so the old token is simply unknown: 401
    await expect(alice.client.me()).rejects.toMatchObject({ kind: "auth" });
    expect(await title(olive, "c1")).toBe("One");
  });

  it("a restricted space with only olive as member never appears in alice's /me or database", async () => {
    const created = await hub.api(ownerToken)("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "1", canWrite: true }] });
    expect(created.status).toBe(201);
    const secretId = created.body.space.id as string;
    await vi.waitFor(async () => expect(await olive.db.space.count({ where: { hubSpaceId: secretId } })).toBe(1), { timeout: 3000 });
    const secret = await olive.space(secretId);
    await makeProject(olive, "s1", "Hidden", secret.id);
    await olive.engine.syncSpace(secret);
    expect(hubVersion(secretId, "project", "s1")).toBe(1);
    await alice.sync();
    const me = await alice.client.me();
    expect(me.spaces.map((s) => s.id)).not.toContain(secretId);
    expect(await alice.db.space.count({ where: { hubSpaceId: secretId } })).toBe(0);
    expect(await alice.db.project.findUnique({ where: { id: "s1" } })).toBeNull();
    await expect(alice.client.pull(secretId, 0n)).rejects.toMatchObject({ kind: "not-found" });
    expect((await olive.db.project.findUnique({ where: { id: "s1" } }))?.name).toBe("Hidden");
  });
});

/**
 * The hub's database is replaced by an older copy of itself (a real file-level restore: stop the hub, put the backup file back, start it again on
 * the same address), with the clients' sessions restored along with it. No client may silently diverge, and nothing unsent may be dropped.
 */
describe("hub restored from a backup", () => {
  async function backupHub(): Promise<string> {
    const copy = path.join(hub.dataDir, "backup.db");
    await hub.db.backup(copy);
    return copy;
  }
  async function restoreHub(backup: string): Promise<void> {
    const port = Number(new URL(hub.url).port);
    const dataDir = hub.dataDir;
    await hub.close();
    for (const sfx of ["-wal", "-shm"]) fs.rmSync(path.join(dataDir, "hub.db" + sfx), { force: true });
    fs.copyFileSync(backup, path.join(dataDir, "hub.db"));
    hub = await startTestHub({ dataDir, port });
  }
  /** The first request on a connection the old process held open fails once, as it would for a real client; the retry is the client's own backoff. */
  const resync = async (c: Client) => {
    try {
      await c.sync();
    } catch (e) {
      if (!(e instanceof HubError) || e.kind !== "network") throw e;
      await c.sync();
    }
  };
  const hubTitle = (id: string) => (JSON.parse((hub.db.prepare("SELECT data FROM entity WHERE space_id = 'common' AND type = 'card' AND entity_id = ?").get(id) as { data: string }).data) as { title: string }).title;
  const records = (c: Client) => c.db.hubRestore.findMany({ orderBy: { at: "asc" } });

  it("clean clients that were newer than the backup are rolled back to it, explicitly, and the old copy can be sent again", async () => {
    await seedBoard();
    const backup = await backupHub();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Newer" } });
    await olive.engine.syncSpace(await olive.space("common"));
    await resync(alice);
    expect(await title(alice, "c1")).toBe("Newer");

    await restoreHub(backup);
    expect(hubTitle("c1")).toBe("One");
    await resync(olive);
    await resync(alice);

    expect(await title(olive, "c1")).toBe("One");
    expect(await title(alice, "c1")).toBe("One");
    for (const c of [olive, alice]) {
      const [rec] = await records(c);
      expect(rec).toMatchObject({ status: "OPEN", rolledBack: 1, kept: 0 });
      expect(rec.detail).toEqual([expect.objectContaining({ type: "card", entityId: "c1", resend: true, data: expect.objectContaining({ title: "Newer" }) })]);
    }

    const [rec] = await records(alice);
    expect(await alice.engine.resendRestored(rec.id)).toEqual({ queued: 1 });
    await alice.engine.syncSpace(await alice.space("common"));
    expect(hubTitle("c1")).toBe("Newer");
    await resync(olive);
    expect(await title(olive, "c1")).toBe("Newer");
    expect((await records(alice))[0].status).toBe("RESENT");
    await olive.engine.dismissRestored((await records(olive))[0].id);
    expect((await records(olive))[0].status).toBe("DISMISSED");
  });

  it("an offline client whose cursor the restored hub has moved past is not left on its own history", async () => {
    await seedBoard();
    const backup = await backupHub();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Newer-after-backup" } });
    await olive.engine.syncSpace(await olive.space("common"));
    await resync(alice);
    expect(await title(alice, "c1")).toBe("Newer-after-backup");
    const aliceCursor = (await alice.space("common")).hubCursor;

    await restoreHub(backup);
    await resync(olive); // olive notices first: the hub is behind her cursor
    expect(await title(olive, "c1")).toBe("One");
    for (const t of ["x1", "x2", "x3"]) {
      await olive.db.planningItem.update({ where: { id: "c2" }, data: { title: t } });
      await olive.engine.syncSpace(await olive.space("common"));
    }
    // the restored hub has moved PAST alice's cursor, so a bare event pull would have looked normal
    expect(BigInt((hub.db.prepare("SELECT seq FROM space WHERE id = 'common'").get() as { seq: number }).seq)).toBeGreaterThan(aliceCursor);

    await resync(alice);
    expect(await title(alice, "c1")).toBe("One");
    expect(await title(alice, "c2")).toBe("x3");
    expect(await alice.db.hubRestore.count({ where: { status: "OPEN", rolledBack: { gte: 1 } } })).toBe(1);
  });

  it("unsent edits survive a restore: kept, merged against the restored state and sent", async () => {
    await seedBoard();
    const backup = await backupHub();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Newer" } });
    await olive.engine.syncSpace(await olive.space("common"));
    await resync(alice);
    await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: "Mine" } });
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count({ where: { entityId: "c2", status: "PENDING" } })).toBe(1);

    await restoreHub(backup);
    await resync(alice);

    expect(await title(alice, "c2")).toBe("Mine");
    expect(await title(alice, "c1")).toBe("One");
    expect(hubTitle("c2")).toBe("Mine");
    expect(await alice.db.outboxOp.count({ where: { status: { in: ["FAILED", "QUARANTINED", "CONFLICT"] } } })).toBe(0);
    const [rec] = await records(alice);
    expect(rec).toMatchObject({ status: "OPEN", rolledBack: 1, kept: 1 });
  });

  it("a card created after the backup is gone from the restored hub: listed as replaced, and sendable again against version 0", async () => {
    await seedBoard();
    const backup = await backupHub();
    await makeCard(olive, "p1", "c3", "Created later");
    await olive.engine.syncSpace(await olive.space("common"));
    await alice.sync();
    expect(await title(alice, "c3")).toBe("Created later");

    await restoreHub(backup);
    await resync(alice);
    expect(await alice.db.planningItem.findUnique({ where: { id: "c3" } })).toBeNull();
    const [rec] = await records(alice);
    expect(rec.detail).toEqual([expect.objectContaining({ type: "card", entityId: "c3", resend: true, hubVersion: 0, data: expect.objectContaining({ title: "Created later" }) })]);

    expect(await alice.engine.resendRestored(rec.id)).toEqual({ queued: 1 });
    await alice.engine.syncSpace(await alice.space("common"));
    expect(hubTitle("c3")).toBe("Created later");
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("an ordinary restart of the same database is not reported as a restore, even when a client is behind", async () => {
    await seedBoard();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Ahead" } });
    await olive.engine.syncSpace(await olive.space("common"));
    const port = Number(new URL(hub.url).port);
    const dataDir = hub.dataDir;
    await hub.close();
    hub = await startTestHub({ dataDir, port });
    await resync(alice);
    expect(await title(alice, "c1")).toBe("Ahead");
    expect(await alice.db.hubRestore.count()).toBe(0);
  });

  it("repeated ordinary restarts, with edits, offline clients and unsent edits in between, never produce a restore record", async () => {
    await seedBoard();
    const port = Number(new URL(hub.url).port);
    const dataDir = hub.dataDir;
    for (let i = 1; i <= 5; i++) {
      // olive edits and sends; alice is behind (offline) for the restart, and holds an unsent edit on a different card on odd rounds
      await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: `Olive-${i}` } });
      await olive.engine.syncSpace(await olive.space("common"));
      if (i % 2) {
        await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: `Alice-${i}` } });
        await alice.engine.capture();
      }
      await hub.close();
      hub = await startTestHub({ dataDir, port });
      await resync(alice);
      await resync(olive);
      expect(await title(alice, "c1")).toBe(`Olive-${i}`);
      if (i % 2) await vi.waitFor(async () => expect(await title(olive, "c2")).toBe(`Alice-${i}`), { timeout: 3000 });
      expect(await olive.db.hubRestore.count(), `olive after restart ${i}`).toBe(0);
      expect(await alice.db.hubRestore.count(), `alice after restart ${i}`).toBe(0);
      expect(await alice.db.syncConflict.count()).toBe(0);
    }
  });

  it("a restore that loses nothing local leaves no record, and an ordinary prune is not treated as a restore", async () => {
    await seedBoard();
    const backup = await backupHub();
    await restoreHub(backup);
    await resync(olive);
    await resync(alice);
    expect(await olive.db.hubRestore.count()).toBe(0);
    expect(await alice.db.hubRestore.count()).toBe(0);
  });
});
