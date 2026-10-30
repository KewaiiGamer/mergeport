import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prune } from "../../hub/src/entities";
import { signInAs, startTestHub, type TestHub } from "./harness";

const DAY = 24 * 60 * 60 * 1000;
let clock = Date.UTC(2026, 9, 1);
let hub: TestHub;
let owner: string;
let api: ReturnType<TestHub["api"]>;
beforeEach(async () => {
  clock = Date.UTC(2026, 9, 1);
  hub = await startTestHub({ now: () => clock });
  owner = await signInAs(hub, 1n, "olive");
  api = hub.api(owner);
});
afterEach(async () => {
  await hub.close();
});

const up = (opId: string, entityId: string, baseVersion = 0, data: Record<string, unknown> = { title: opId }) => ({ opId, type: "task", entityId, kind: "UPSERT", baseVersion, data });
const post = (a: ReturnType<TestHub["api"]>, spaceId: string, ...o: unknown[]) => a("POST", `/spaces/${spaceId}/ops`, { ops: o });
const eventSeqs = () => (hub.db.prepare("SELECT seq FROM entity_event ORDER BY seq").all() as { seq: number }[]).map((r) => r.seq);

describe("GET /spaces/:id/entities", () => {
  it("entities?since returns only newer events and advances seq", async () => {
    await post(api, "common", up("a", "t1"), up("b", "t2"));
    const all = await api("GET", "/spaces/common/entities?since=0");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ seq: "2", more: false });
    expect(all.body.events.map((e: any) => [e.seq, e.id, e.opId])).toEqual([
      ["1", "t1", "a"],
      ["2", "t2", "b"],
    ]);
    expect(all.body.events[0]).toMatchObject({ schema: 1, type: "task", version: 1, deleted: false, updatedBy: { id: "1", login: "olive" }, data: { title: "a" } });
    await post(api, "common", up("c", "t1", 1, { title: "c" }));
    const next = await api("GET", "/spaces/common/entities?since=2");
    expect(next.body.seq).toBe("3");
    expect(next.body.events).toHaveLength(1);
    expect(next.body.events[0]).toMatchObject({ seq: "3", id: "t1", version: 2, opId: "c" });
    const none = await api("GET", "/spaces/common/entities?since=3");
    expect(none.body).toEqual({ epoch: expect.any(String), seq: "3", seqOp: "c", events: [], more: false });
  });

  it("pages with limit and more", async () => {
    await post(api, "common", up("a", "t1"), up("b", "t2"), up("c", "t3"));
    const p1 = await api("GET", "/spaces/common/entities?since=0&limit=2");
    expect(p1.body).toMatchObject({ seq: "2", more: true });
    expect(p1.body.events).toHaveLength(2);
    const p2 = await api("GET", "/spaces/common/entities?since=2&limit=2");
    expect(p2.body).toMatchObject({ seq: "3", more: false });
  });

  it("rejects a bad since with 400", async () => {
    for (const s of ["abc", "-1", "1.5", "99999999999999999999"]) expect((await api("GET", `/spaces/common/entities?since=${s}`)).status, s).toBe(400);
  });

  it("entities of a restricted space are 404 to a non-member (not 403)", async () => {
    hub.github.addUser({ id: 2n, login: "mia" });
    await api("POST", "/admin/invites", { githubLogin: "mia", role: "MEMBER" });
    const mia = hub.api(await signInAs(hub, 2n, "mia"));
    const sp = await api("POST", "/admin/spaces", { name: "Secret", members: [] });
    const id = sp.body.space.id;
    for (const p of ["entities?since=0", "snapshot"]) {
      const r = await mia("GET", `/spaces/${id}/${p}`);
      expect(r.status, p).toBe(404);
      expect(r.body).toEqual((await mia("GET", `/spaces/no-such-space/${p}`)).body);
    }
    expect((await mia("POST", `/spaces/${id}/ops`, { ops: [up("a", "t1")] })).status).toBe(404);
    // membership, not role, grants access to a restricted space (an owner outside it is 404 too)
    expect((await api("GET", `/spaces/${id}/snapshot`)).status).toBe(404);
  });
});

describe("GET /spaces/:id/snapshot", () => {
  it("snapshot includes tombstones", async () => {
    await post(api, "common", up("a", "t1"), up("b", "t2"));
    await post(api, "common", { opId: "d", type: "task", entityId: "t2", kind: "DELETE", baseVersion: 1 });
    const s = await api("GET", "/spaces/common/snapshot");
    expect(s.status).toBe(200);
    expect(s.body.seq).toBe("3");
    const byId = Object.fromEntries(s.body.entities.map((e: any) => [e.id, e]));
    expect(byId.t1).toMatchObject({ deleted: false, version: 1 });
    expect(byId.t2).toMatchObject({ deleted: true, version: 2, data: {} });
  });
});

describe("pruning", () => {
  it("since older than retained log is 410 after prune; snapshot recovers", async () => {
    await post(api, "common", up("a", "t1"), up("b", "t2"));
    expect((await api("GET", "/spaces/common/entities?since=0")).body.seq).toBe("2");
    clock += 20 * DAY;
    expect((await api("GET", "/spaces/common/entities?since=2")).status).toBe(200); // slides the session; cursor 2
    clock += 11 * DAY;
    prune(hub.db, clock);
    expect(eventSeqs()).toEqual([]);
    const gone = await api("GET", "/spaces/common/entities?since=0");
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({ error: "gone" });
    expect((await api("GET", "/spaces/common/entities?since=1")).status).toBe(410);
    expect((await api("GET", "/spaces/common/entities?since=2")).status).toBe(200); // caught up, empty log
    const snap = await api("GET", "/spaces/common/snapshot");
    expect(snap.body.entities).toHaveLength(2);
    expect(snap.body.seq).toBe("2");
    await post(api, "common", up("c", "t3"));
    const r = await api("GET", "/spaces/common/entities?since=2");
    expect(r.body.events.map((e: any) => e.seq)).toEqual(["3"]);
  });

  it("prune keeps events an active session has not read yet", async () => {
    hub.github.addUser({ id: 2n, login: "mia" });
    await api("POST", "/admin/invites", { githubLogin: "mia", role: "MEMBER" });
    const mia = hub.api(await signInAs(hub, 2n, "mia"));
    await post(api, "common", up("a", "t1"));
    await mia("GET", "/spaces/common/entities?since=0");
    await mia("GET", "/spaces/common/entities?since=1"); // mia cursor 1
    await post(api, "common", up("b", "t2"), up("c", "t3"));
    await api("GET", "/spaces/common/entities?since=3"); // owner cursor 3
    clock += 20 * DAY;
    expect((await mia("GET", "/me")).status).toBe(200); // keep mia's session alive without reading
    expect((await api("GET", "/me")).status).toBe(200);
    clock += 11 * DAY;
    prune(hub.db, clock);
    expect(eventSeqs()).toEqual([2, 3]); // only what mia has read is pruned
    expect((await mia("GET", "/spaces/common/entities?since=1")).body.events.map((e: any) => e.seq)).toEqual(["2", "3"]);
    expect((await mia("GET", "/spaces/common/entities?since=0")).status).toBe(410);
  });

  it("prune keeps events younger than 30 days; expired sessions do not hold the log", async () => {
    await post(api, "common", up("a", "t1"));
    await api("GET", "/spaces/common/entities?since=0"); // cursor 0: holds the log while the session is active
    clock += 29 * DAY;
    prune(hub.db, clock);
    expect(eventSeqs()).toEqual([1]);
    clock += 2 * DAY; // 31d: event old; session (last seen day 0) expired
    prune(hub.db, clock);
    expect(eventSeqs()).toEqual([]);
  });

  it("cursor never moves backwards", async () => {
    await post(api, "common", up("a", "t1"), up("b", "t2"));
    await api("GET", "/spaces/common/entities?since=2");
    await api("GET", "/spaces/common/entities?since=1");
    const row = hub.db.prepare("SELECT cursor_json FROM session").get() as { cursor_json: string };
    expect(JSON.parse(row.cursor_json)).toEqual({ common: "2" });
  });
});

describe("entity_event op index", () => {
  it("dupEvent's lookup is answered by the (space_id, type, entity_id, op_id) index, not a scan", async () => {
    expect(hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'entity_event_op'").get()).toEqual({ name: "entity_event_op" });
    const plan = hub.db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM entity_event WHERE space_id = ? AND type = ? AND entity_id = ? AND op_id = ? LIMIT 1").all("common", "task", "t1", "op") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("USING COVERING INDEX entity_event_op");
  });
});


describe("GET /spaces/:id/entities?after= (restored history)", () => {
  it("answers 410 reason history when the op at `since` is not the one the client read, and gives seqOp otherwise", async () => {
    await post(api, "common", up("op-a", "t1"));
    await post(api, "common", up("op-b", "t2"));
    const ok = await api("GET", "/spaces/common/entities?since=2&after=op-b");
    expect(ok.status).toBe(200);
    expect(ok.body.seqOp).toBe("op-b");
    expect((await api("GET", "/spaces/common/entities?since=1&after=op-a")).status).toBe(200); // a prefix of this history
    const other = await api("GET", "/spaces/common/entities?since=2&after=op-elsewhere");
    expect(other.status).toBe(410);
    expect(other.body).toEqual({ error: "gone", reason: "history" });
    expect((await api("GET", "/spaces/common/entities?since=2")).status).toBe(200); // older clients do not send it
    expect((await api("GET", "/spaces/common/entities?since=0&after=anything")).status).toBe(200); // nothing at position 0
    expect((await api("GET", `/spaces/common/entities?since=2&after=${"x".repeat(129)}`)).status).toBe(400);
    expect((await api("GET", "/spaces/common/snapshot")).body.seqOp).toBe("op-b");
  });
});
