import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signInAs, startTestHub, type TestHub } from "./harness";

let hub: TestHub;
let owner: string;
let api: ReturnType<TestHub["api"]>;
beforeEach(async () => {
  hub = await startTestHub();
  owner = await signInAs(hub, 1n, "olive");
  api = hub.api(owner);
});
afterEach(async () => {
  await hub.close();
});

const up = (opId: string, entityId: string, baseVersion: number, data: Record<string, unknown> = { title: "a" }, type = "task") => ({
  opId,
  type,
  entityId,
  kind: "UPSERT",
  baseVersion,
  data,
});
const ops = (...o: unknown[]) => api("POST", "/spaces/common/ops", { ops: o });

describe("POST /spaces/:id/ops", () => {
  it("applies, reports duplicate on retry, and stale on wrong baseVersion", async () => {
    const r1 = await ops(up("op1", "t1", 0));
    expect(r1.status).toBe(200);
    expect(r1.body.results[0]).toMatchObject({ opId: "op1", status: "applied", version: 1 });
    expect(r1.body.seq).toBe("1");
    const r2 = await ops(up("op1", "t1", 0));
    expect(r2.body.results[0].status).toBe("duplicate");
    expect(r2.body.seq).toBe("1");
    const r3 = await ops(up("op2", "t1", 0, { title: "b" }));
    expect(r3.body.results[0]).toMatchObject({ status: "stale", version: 1, current: { id: "t1", version: 1, data: { title: "a" } } });
    expect(r3.body.seq).toBe("1");
  });

  it("two ops on one entity in one request apply in order", async () => {
    const r = await ops(up("a", "t1", 0, { n: 1 }), up("b", "t1", 1, { n: 2 }));
    expect(r.body.results.map((x: any) => [x.status, x.version])).toEqual([
      ["applied", 1],
      ["applied", 2],
    ]);
    expect(r.body.seq).toBe("2");
    const snap = await api("GET", "/spaces/common/snapshot");
    expect(snap.body.entities).toHaveLength(1);
    expect(snap.body.entities[0]).toMatchObject({ version: 2, data: { n: 2 } });
  });

  it("two ops with the same baseVersion in one request: second is stale, not lost", async () => {
    const r = await ops(up("a", "t1", 0, { n: 1 }), up("b", "t1", 0, { n: 2 }));
    expect(r.body.results[1]).toMatchObject({ status: "stale", version: 1, current: { data: { n: 1 } } });
  });

  it("a delete is a tombstone with a version", async () => {
    await ops(up("a", "t1", 0));
    const r = await ops({ opId: "d", type: "task", entityId: "t1", kind: "DELETE", baseVersion: 1, data: { ignored: true } });
    expect(r.body.results[0]).toMatchObject({ status: "applied", version: 2 });
    const snap = await api("GET", "/spaces/common/snapshot");
    expect(snap.body.entities[0]).toMatchObject({ id: "t1", version: 2, deleted: true, data: {} });
  });

  it("appliedOps keeps the last 50", async () => {
    const batch = Array.from({ length: 60 }, (_, i) => up(`o${i}`, "t1", i, { i }));
    const r = await ops(...batch);
    expect(r.body.results.every((x: any) => x.status === "applied")).toBe(true);
    const snap = await api("GET", "/spaces/common/snapshot");
    const e = snap.body.entities[0];
    expect(e.version).toBe(60);
    expect(e.appliedOps).toHaveLength(50);
    expect(e.appliedOps[0]).toBe("o10");
    expect(e.appliedOps[49]).toBe("o59");
    // a trimmed op is still detected as duplicate through the event log
    const dup = await ops(up("o0", "t1", 0, { i: 0 }));
    expect(dup.body.results[0].status).toBe("duplicate");
  });

  it("records updatedBy and the entity shape", async () => {
    await ops(up("a", "t1", 0));
    const e = (await api("GET", "/spaces/common/snapshot")).body.entities[0];
    expect(e).toMatchObject({ schema: 1, type: "task", id: "t1", version: 1, deleted: false, appliedOps: ["a"], updatedBy: { id: "1", login: "olive" } });
    expect(typeof e.updatedAt).toBe("string");
  });

  it("a READER gets 403 on ops, 200 on entities", async () => {
    hub.github.addUser({ id: 2n, login: "rita" });
    expect((await api("POST", "/admin/invites", { githubLogin: "rita", role: "READER" })).status).toBe(201);
    const rita = await signInAs(hub, 2n, "rita");
    const r = await hub.api(rita)("POST", "/spaces/common/ops", { ops: [up("a", "t1", 0)] });
    expect(r.status).toBe(403);
    expect((await hub.api(rita)("GET", "/spaces/common/entities?since=0")).status).toBe(200);
    expect((await hub.api(rita)("GET", "/spaces/common/snapshot")).status).toBe(200);
  });

  it("401 without a session, 404 on unknown space", async () => {
    expect((await hub.api()("POST", "/spaces/common/ops", { ops: [] })).status).toBe(401);
    expect((await api("POST", "/spaces/nope/ops", { ops: [up("a", "t1", 0)] })).status).toBe(404);
  });

  it("rejects bad bodies with 400: ops not array, baseVersion string, 501 ops, oversized data", async () => {
    const bad: unknown[] = [
      { ops: "x" },
      { ops: { a: 1 } },
      {},
      [],
      { ops: [{ ...up("a", "t1", 0), baseVersion: "0" }] },
      { ops: [{ ...up("a", "t1", 0), baseVersion: -1 }] },
      { ops: [{ ...up("a", "t1", 0), baseVersion: 1.5 }] },
      { ops: [{ ...up("a", "t1", 0), kind: "PATCH" }] },
      { ops: [{ ...up("a", "t1", 0), data: [1] }] },
      { ops: [up("a", "t1", 0, {}, "Bad_Type")] },
      { ops: [up("a", "x".repeat(129), 0)] },
      { ops: [up("", "t1", 0)] },
      { ops: Array.from({ length: 501 }, (_, i) => up(`o${i}`, `t${i}`, 0)) },
      { ops: [up("a", "t1", 0, { blob: "x".repeat(256 * 1024) })] },
    ];
    for (const [i, body] of bad.entries()) {
      const r = await api("POST", "/spaces/common/ops", body);
      expect(r.status, `case ${i}`).toBe(400);
    }
    expect((await api("GET", "/spaces/common/snapshot")).body.entities).toEqual([]);
    expect((await ops(...Array.from({ length: 500 }, (_, i) => up(`o${i}`, `t${i}`, 0)))).status).toBe(200);
  });

  it("non-JSON body is 400, never a crash or partial write", async () => {
    const h = { authorization: `Bearer ${owner}`, "content-type": "application/json" };
    const r = await fetch(`${hub.url}/spaces/common/ops`, { method: "POST", headers: h, body: "{not json" });
    expect(r.status).toBe(400);
    const e = await fetch(`${hub.url}/spaces/common/ops`, { method: "POST", headers: h });
    expect(e.status).toBe(400);
    expect((await api("GET", "/spaces/common/snapshot")).body.seq).toBe("0");
  });

  it("a bad op later in the batch leaves earlier ops unapplied", async () => {
    const r = await ops(up("a", "t1", 0), { ...up("b", "t2", 0), baseVersion: "x" });
    expect(r.status).toBe(400);
    expect((await api("GET", "/spaces/common/snapshot")).body.entities).toEqual([]);
  });

  it("seq survives a restart", async () => {
    await hub.close();
    const dataDir = mkdtempSync(path.join(tmpdir(), "hub-restart-"));
    hub = await startTestHub({ dataDir });
    owner = await signInAs(hub, 1n, "olive");
    api = hub.api(owner);
    const r = await ops(up("a", "t1", 0), up("b", "t2", 0), up("c", "t3", 0));
    expect(r.body.seq).toBe("3");
    await hub.close();
    hub = await startTestHub({ dataDir });
    api = hub.api(owner); // sessions persist in the db
    const r2 = await ops(up("d", "t4", 0));
    expect(r2.status).toBe(200);
    expect(r2.body.results[0].status).toBe("applied");
    expect(r2.body.seq).toBe("4");
  });

  it("restricted space: can_write member writes; read-only member 403; non-member 404", async () => {
    for (const [id, l] of [[2n, "mia"], [3n, "max"], [4n, "nia"]] as const) {
      hub.github.addUser({ id, login: l });
      await api("POST", "/admin/invites", { githubLogin: l, role: "MEMBER" });
    }
    const mia = await signInAs(hub, 2n, "mia");
    const max = await signInAs(hub, 3n, "max");
    const nia = await signInAs(hub, 4n, "nia");
    const sp = await api("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "2", canWrite: true }, { githubId: "3", canWrite: false }] });
    const id = sp.body.space.id;
    const w = (t: string) => hub.api(t)("POST", `/spaces/${id}/ops`, { ops: [up("a", "t1", 0)] });
    expect((await w(mia)).status).toBe(200);
    expect((await w(max)).status).toBe(403);
    expect((await w(nia)).status).toBe(404);
  });
});
