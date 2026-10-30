import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHub } from "./hub-client/fake-hub";
import { HubError } from "@/lib/hub/types";
import { checkHubHealth } from "@/lib/hub/client";
import type { SocketLike } from "@/lib/hub/link";
import { expectedConsistencyDelaySeconds } from "@/lib/sync/engine";
import { ManualTimers } from "./hub-client/manual-timers";
import { cardData, makeHubClient, projectData, type HubTestClient } from "./hub-client/harness";

let hub: FakeHub;
let olive: HubTestClient;
let alice: HubTestClient;
const open: HubTestClient[] = [];

beforeEach(async () => {
  hub = new FakeHub();
  hub.addMember("1", "olive", "OWNER");
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  hub.createSpace("secret", "RESTRICTED", "Secret", ["1"]);
  await hub.listen();
  olive = await makeHubClient(hub, 1n, "olive");
  alice = await makeHubClient(hub, 2n, "alice");
  open.push(olive, alice);
});
afterEach(async () => {
  while (open.length) await open.pop()!.close();
  await hub.close();
});

const seedBoard = () => {
  hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
  hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Ship it") });
};

describe("hub pull", () => {
  it("alice receives the owner's project after one sync", async () => {
    seedBoard();
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p1" } }))?.name).toBe("Atlas");
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Ship it");
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });

  it("a second sync with no news changes nothing", async () => {
    seedBoard();
    await alice.sync();
    const sp = await alice.space("common");
    expect(await alice.engine.pullSpace(sp)).toEqual({ changed: false, applied: 0 });
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("only the latest event per entity is applied", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Ship it v2") });
    await alice.sync();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Ship it v2");
  });

  it("entity delete arrives as tombstone and removes the local row", async () => {
    seedBoard();
    await alice.sync();
    hub.inject("common", { type: "card", id: "c1", deleted: true });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect(await alice.db.project.findUnique({ where: { id: "p1" } })).not.toBeNull();
  });

  it("cursor expiry: pruned history resyncs from the snapshot, absent entities are deleted, cursor equals hub seq", async () => {
    seedBoard();
    await alice.sync();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Second") });
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c3", data: cardData("p1", "Third") });
    hub.pruneBefore(hub.seq("common"));
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c2" } }))?.title).toBe("Second");
    expect(await alice.db.planningItem.findUnique({ where: { id: "c3" } })).not.toBeNull();
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });

  it("a vanished entity with a pending local edit is kept", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Mine" } });
    await alice.engine.capture();
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c9", data: cardData("p1", "Other") });
    hub.pruneBefore(hub.seq("common"));
    await alice.engine.pullSpace(await alice.space("common"));
    expect((await alice.db.planningItem.findUnique({ where: { id: "c1" } }))?.title).toBe("Mine");
  });

  it("hub seq lower than local cursor (reset) resyncs from snapshot, no stall", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Two") });
    await alice.sync();
    expect((await alice.space("common")).hubCursor).toBe(3n);
    hub.resetSeq("common", 1n);
    hub.dropEntity("common", "card", "c2");
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c2" } })).toBeNull();
    expect((await alice.space("common")).hubCursor).toBe(1n);
    hub.inject("common", { type: "card", id: "c4", data: cardData("p1", "Four") });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c4" } })).not.toBeNull();
  });

  it("pages through `more` and accumulates", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    for (let i = 0; i < 520; i++) hub.inject("common", { type: "card", id: `c${i}`, data: cardData("p1", `T${i}`) });
    await alice.sync();
    expect(await alice.db.planningItem.count()).toBe(520);
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });
});

describe("hub guards", () => {
  it("a newer schema is blocked, unknown types ignored, others applied, cursor advances", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    hub.inject("common", { type: "card", id: "c1", schema: 2, data: cardData("p1", "Future") });
    hub.inject("common", { type: "hologram", id: "h1", data: { x: 1 } });
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Fine") });
    await alice.sync();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
    expect((await alice.db.planningItem.findUnique({ where: { id: "c2" } }))?.title).toBe("Fine");
    const sp = await alice.space("common");
    const se = await alice.db.syncEntity.findUniqueOrThrow({ where: { spaceId_type_entityId: { spaceId: sp.id, type: "card", entityId: "c1" } } });
    expect((se.meta as { newer?: boolean }).newer).toBe(true);
    expect(await alice.db.syncEntity.count({ where: { spaceId: sp.id, type: "hologram" } })).toBe(0);
    expect(sp.hubCursor).toBe(hub.seq("common"));
  });

  it("an entity that throws is retried next pull, cursor held, others applied", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas", "atlas") });
    hub.inject("common", { type: "project", id: "p2", data: projectData("Clash", "atlas") }); // unique slug violation
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Fine") });
    await alice.sync();
    expect(await alice.db.project.findUnique({ where: { id: "p2" } })).toBeNull();
    expect(await alice.db.planningItem.findUnique({ where: { id: "c1" } })).not.toBeNull();
    let sp = await alice.space("common");
    expect(sp.hubCursor).toBe(1n);
    expect(sp.lastError).toMatch(/^Skipped 1 unreadable entity/);
    hub.inject("common", { type: "project", id: "p2", data: projectData("Clash", "clash") });
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p2" } }))?.slug).toBe("clash");
    sp = await alice.space("common");
    expect(sp.hubCursor).toBe(hub.seq("common"));
    expect(sp.lastError).toBeNull();
  });

  it("an entity placed in another space is not overwritten from here", async () => {
    await olive.sync();
    await olive.db.project.create({ data: { id: "p1", workspaceId: olive.profile.workspace.id, name: "Mine", slug: "mine", spaceId: (await olive.space("secret")).id } });
    hub.inject("common", { type: "project", id: "p1", data: projectData("Atlas") });
    await olive.engine.pullSpace(await olive.space("common"));
    expect((await olive.db.project.findUnique({ where: { id: "p1" } }))?.name).toBe("Mine");
  });
});

describe("hub access and errors", () => {
  it("a restricted space is absent for a non-member, and answers 404", async () => {
    hub.inject("secret", { type: "project", id: "s1", data: projectData("Secret") });
    await alice.sync();
    expect(await alice.db.space.findFirst({ where: { hubSpaceId: "secret" } })).toBeNull();
    expect(await alice.db.project.findUnique({ where: { id: "s1" } })).toBeNull();
    await expect(alice.client.pull("secret", 0n)).rejects.toMatchObject({ kind: "not-found" });
    await olive.sync();
    expect(await olive.db.project.findUnique({ where: { id: "s1" } })).not.toBeNull();
  });

  it("access removed revokes: rows purged, ops quarantined, space revoked", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Local edit" } });
    await alice.engine.capture();
    hub.removeMember("2");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.access).toBe("REVOKED");
    expect(sp.lastError).toBeTruthy();
    expect(await alice.db.project.count()).toBe(0);
    expect(await alice.db.planningItem.count()).toBe(0);
    const ops = await alice.db.outboxOp.findMany();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.status === "QUARANTINED")).toBe(true);
  });

  it("a space that vanishes from /me is revoked by syncHubSpaces", async () => {
    hub.inject("secret", { type: "project", id: "s1", data: projectData("Secret") });
    await olive.sync();
    hub.deleteSpace("secret");
    await olive.sync();
    expect((await olive.space("secret")).access).toBe("REVOKED");
    expect(await olive.db.project.findUnique({ where: { id: "s1" } })).toBeNull();
  });

  it("network failure: lastError offline, state offline, edits stay pending", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited offline" } });
    hub.failNext(20, "network");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.lastError).toBe("offline");
    expect((await alice.engine.stateFor(sp)).state).toBe("offline");
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("401: sign-in message, ops kept", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    hub.revokeToken("2");
    await alice.sync();
    const sp = await alice.space("common");
    expect(sp.lastError).toBe("Sign in to the server again");
    expect(sp.access).toBe("OK");
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
  });

  it("429 sets rateLimitedUntil", async () => {
    await alice.sync();
    hub.failNext(1, "rate-limited");
    await alice.engine.pullSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.rateLimitedUntil).not.toBeNull();
    expect((await alice.engine.stateFor(sp)).state).toBe("rate-limited");
  });
});

const cardKey = (spaceId: string, id = "c1") => ({ spaceId_type_entityId: { spaceId, type: "card", entityId: id } });
const title = async (c: HubTestClient, id = "c1") => (await c.db.planningItem.findUnique({ where: { id } }))?.title;

describe("hub push", () => {
  it("edit on olive reaches alice through push + pull (outbox empty, hub entity version 1)", async () => {
    await olive.sync();
    const sp = await olive.space("common");
    await olive.db.project.create({ data: { id: "p9", workspaceId: olive.profile.workspace.id, name: "Nine", slug: "nine", spaceId: sp.id } });
    await olive.sync();
    expect(hub.entity("common", "project", "p9")?.version).toBe(1);
    expect(await olive.db.outboxOp.count()).toBe(0);
    await alice.sync();
    expect((await alice.db.project.findUnique({ where: { id: "p9" } }))?.name).toBe("Nine");
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("concurrent edits to DIFFERENT entities: both applied, no stale, no conflict", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Second") });
    await olive.sync();
    await alice.sync();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "O1" } });
    await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: "A2" } });
    await olive.sync();
    await alice.sync();
    await olive.sync();
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
    expect(hub.entity("common", "card", "c2")?.version).toBe(2);
    expect(await title(olive, "c2")).toBe("A2");
    expect(await title(alice, "c1")).toBe("O1");
    expect(await olive.db.syncConflict.count()).toBe(0);
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("same entity, different fields: one stale, three-way merged, retried in the same cycle, both fields present on both clients after sync, no SyncConflict", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { priority: 2 } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "O1" } });
    await olive.sync();
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 1 });
    expect(hub.opsRequests - before).toBe(2); // stale, then the merged retry
    await olive.sync();
    await alice.sync();
    for (const c of [olive, alice]) {
      const row = await c.db.planningItem.findUniqueOrThrow({ where: { id: "c1" } });
      expect(row.title).toBe("O1");
      expect(row.priority).toBe(2);
      expect(await c.db.syncConflict.count()).toBe(0);
      expect(await c.db.outboxOp.count()).toBe(0);
    }
    expect(hub.entity("common", "card", "c1")?.version).toBe(3);
  });

  it("same field: SyncConflict OPEN with that field, op CONFLICT, nothing sent until resolveConflict(..., \"mine\")", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Alice" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Olive" } });
    await olive.sync();
    const sp = await alice.space("common");
    await alice.engine.pushSpace(sp);
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["title"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 0 });
    expect(hub.opsRequests).toBe(before);
    expect(hub.entity("common", "card", "c1")?.data.title).toBe("Olive");
    await alice.engine.resolveConflict(c.id, "mine");
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 1 });
    expect(hub.entity("common", "card", "c1")?.data.title).toBe("Alice");
    await olive.sync();
    expect(await title(olive)).toBe("Alice");
  });

  it("lost response (hub.dropNextResponse()): first push throws network, ops back to PENDING, second push gets duplicate, hub applied once (version 1), op gone, base correct", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Lost" } });
    await alice.engine.capture();
    hub.dropNextResponse();
    const sp = await alice.space("common");
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 0 });
    const op = await alice.db.outboxOp.findFirstOrThrow();
    expect(op.status).toBe("PENDING");
    expect(op.error).toBeTruthy();
    expect(hub.entity("common", "card", "c1")?.version).toBe(2); // applied exactly once (v1 was the seed)
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 0 });
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
    expect(await alice.db.outboxOp.count()).toBe(0);
    const se = await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) });
    expect(se.baseVersion).toBe(2);
    expect((se.baseData as { title: string }).title).toBe("Lost");
    expect((se.meta as { applied: string[] }).applied).toContain(op.id);
  });

  it("duplicate with a newer remote version leaves base untouched and a later pull converges", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Mine" } });
    await alice.engine.capture();
    hub.dropNextResponse();
    await alice.engine.pushSpace(await alice.space("common"));
    hub.inject("common", { type: "card", id: "c1", data: { ...cardData("p1", "Mine"), priority: 5 } }); // v3
    const sp = await alice.space("common");
    await alice.engine.pushSpace(sp);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect((await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) })).baseVersion).toBe(1);
    await alice.sync();
    expect((await alice.db.syncEntity.findUniqueOrThrow({ where: cardKey(sp.id) })).baseVersion).toBe(3);
    const row = await alice.db.planningItem.findUniqueOrThrow({ where: { id: "c1" } });
    expect([row.title, row.priority]).toEqual(["Mine", 5]);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c1")?.version).toBe(3);
  });

  it("remote edit vs local delete: conflict with fields [\"__deleted\"]", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.delete({ where: { id: "c1" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    await olive.sync();
    await alice.engine.pushSpace(await alice.space("common"));
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["__deleted"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(false);
  });

  it("local edit vs remote delete: conflict with fields [\"__deleted\"]", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Edited" } });
    await alice.engine.capture();
    await olive.db.planningItem.delete({ where: { id: "c1" } });
    await olive.sync();
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(true);
    await alice.engine.pushSpace(await alice.space("common"));
    const c = await alice.db.syncConflict.findFirstOrThrow({ where: { status: "OPEN" } });
    expect(c.fields).toEqual(["__deleted"]);
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
  });

  it("offline queue: hub stopped, three edits captured and stay PENDING; hub restarted, one sync sends them all", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Two") });
    hub.inject("common", { type: "card", id: "c3", data: cardData("p1", "Three") });
    await alice.sync();
    await hub.close();
    for (const id of ["c1", "c2", "c3"]) await alice.db.planningItem.update({ where: { id }, data: { title: `Off ${id}` } });
    await alice.sync();
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(3);
    expect((await alice.space("common")).lastError).toBe("offline");
    await hub.restart();
    const before = hub.opsRequests;
    await alice.sync();
    expect(hub.opsRequests - before).toBe(1);
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c3")?.data.title).toBe("Off c3");
  });

  it("three-round cap: hub.alwaysStale(entity) leaves ops PENDING after exactly 3 push requests", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Hot" } });
    await alice.engine.capture();
    hub.alwaysStale("common", "card", "c1");
    const before = hub.opsRequests;
    expect(await alice.engine.pushSpace(await alice.space("common"))).toEqual({ sent: 0 });
    expect(hub.opsRequests - before).toBe(3);
    const ops = await alice.db.outboxOp.findMany();
    expect(ops.map((o) => o.status)).toEqual(["PENDING"]);
    expect(await alice.db.syncConflict.count()).toBe(0);
  });

  it("write forbidden (member demoted to READER) -> ops QUARANTINED, canWrite false", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Nope" } });
    await alice.engine.capture();
    hub.setRole("2", "READER");
    await alice.engine.pushSpace(await alice.space("common"));
    const sp = await alice.space("common");
    expect(sp.canWrite).toBe(false);
    expect(sp.access).toBe("OK");
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("QUARANTINED");
    expect(hub.entity("common", "card", "c1")?.version).toBe(1);
  });

  it("delete is pushed as DELETE op and arrives as tombstone", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.delete({ where: { id: "c1" } });
    await alice.sync();
    expect(hub.entity("common", "card", "c1")?.deleted).toBe(true);
    expect(await alice.db.outboxOp.count()).toBe(0);
    await olive.sync();
    expect(await olive.db.planningItem.findUnique({ where: { id: "c1" } })).toBeNull();
  });

  it("a local failure while recording results leaves no op in SENT; the next push converges through duplicates", async () => {
    seedBoard();
    hub.inject("common", { type: "card", id: "c2", data: cardData("p1", "Two") });
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "A1" } });
    await alice.db.planningItem.update({ where: { id: "c2" }, data: { title: "A2" } });
    await alice.engine.capture();
    const spy = vi.spyOn(alice.db.syncEntity, "upsert").mockRejectedValueOnce(new Error("disk full"));
    const sp = await alice.space("common");
    expect(await alice.engine.pushSpace(sp)).toEqual({ sent: 0 });
    spy.mockRestore();
    const ops = await alice.db.outboxOp.findMany();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((o) => o.status === "PENDING" && o.error === "disk full")).toBe(true);
    expect((await alice.space("common")).lastError).toBe("disk full");
    await alice.engine.pushSpace(await alice.space("common"));
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
    expect(hub.entity("common", "card", "c2")?.version).toBe(2);
  });

  it("an op missing from the hub's results goes back to PENDING and is settled by the next push", async () => {
    seedBoard();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "A1" } });
    await alice.engine.capture();
    const real = alice.client.push.bind(alice.client);
    const spy = vi.spyOn(alice.client, "push").mockImplementationOnce(async (s, o) => ({ ...(await real(s, o)), results: [] }));
    await alice.engine.pushSpace(await alice.space("common"));
    spy.mockRestore();
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("PENDING");
    await alice.engine.pushSpace(await alice.space("common"));
    expect(await alice.db.outboxOp.count()).toBe(0);
    expect(hub.entity("common", "card", "c1")?.version).toBe(2);
  });

  it("a snapshot resync keeps a vanished entity that has a CONFLICT op", async () => {
    seedBoard();
    await olive.sync();
    await alice.sync();
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Alice" } });
    await alice.engine.capture();
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Olive" } });
    await olive.sync();
    await alice.engine.pushSpace(await alice.space("common"));
    expect((await alice.db.outboxOp.findFirstOrThrow()).status).toBe("CONFLICT");
    hub.dropEntity("common", "card", "c1");
    hub.inject("common", { type: "card", id: "c9", data: cardData("p1", "Other") });
    hub.pruneBefore(hub.seq("common"));
    await alice.engine.pullSpace(await alice.space("common"));
    expect(await title(alice)).toBe("Alice");
    expect(await alice.db.syncConflict.count({ where: { status: "OPEN" } })).toBe(1);
  });
});

describe("hub live", () => {
  const dead = (): SocketLike => ({ onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} });
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const editCard = async (c: HubTestClient, t: string) => {
    await c.db.planningItem.update({ where: { id: "c1" }, data: { title: t } });
    await c.sync();
  };
  const aliceSockets = () => [...hub.sockets].filter((s) => s.member?.githubId === "2");
  const prepare = async (...clients: HubTestClient[]) => {
    seedBoard();
    for (const c of clients) await c.sync();
  };
  const live = async (c: HubTestClient, o: Parameters<HubTestClient["startLive"]>[0] = {}) => {
    const h = c.startLive(o);
    await vi.waitFor(() => expect(h.live()).toBe(true));
    await sleep(50); // the hello cycle settles
    return h;
  };

  it("live propagation: olive's edit reaches alice's live link in under 1000 ms with no polling", async () => {
    await prepare(olive, alice);
    await live(alice);
    const pull = vi.spyOn(alice.client, "pull");
    const t0 = Date.now();
    await editCard(olive, "Live edit");
    await vi.waitFor(async () => expect(await title(alice)).toBe("Live edit"), { timeout: 1000, interval: 10 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pull).toHaveBeenCalled(); // the changed notification pulled, nothing else asked for it
  });

  it("socket down: the 60 s fallback poll picks the edit up", async () => {
    await prepare(olive, alice);
    const mt = new ManualTimers();
    let n = 0;
    const h = await live(alice, { timers: mt, connect: (_u, p) => (n++ === 0 ? hub.socket(p[1].slice(7)) : dead()) });
    for (const s of aliceSockets()) s.deliverClose(1006);
    expect(h.live()).toBe(false);
    await editCard(olive, "While down");
    mt.advance(59_999);
    await sleep(50);
    expect(await title(alice)).toBe("Ship it");
    mt.advance(1);
    await vi.waitFor(async () => expect(await title(alice)).toBe("While down"));
    expect(h.live()).toBe(false);
  });

  it("hub restart with clients connected: sockets dropped, link reconnects, cursor continues, outage edit arrives", async () => {
    await prepare(olive, alice);
    const mt = new ManualTimers();
    const h = await live(alice, { timers: mt });
    const before = (await alice.space("common")).hubCursor;
    const snapshot = vi.spyOn(alice.client, "snapshot");
    await hub.restart();
    expect(hub.sockets.size).toBe(0);
    expect(h.live()).toBe(false);
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "During outage") });
    mt.advance(1000);
    await vi.waitFor(() => expect(h.live()).toBe(true));
    await vi.waitFor(async () => expect(await title(alice)).toBe("During outage"));
    const after = (await alice.space("common")).hubCursor;
    expect(after).toBe(before + 1n);
    expect(after).toBe(hub.seq("common"));
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("access removed over the socket purges alice's cached rows and quarantines unsent ops", async () => {
    await prepare(alice);
    await live(alice);
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Unsent" } });
    await alice.engine.capture();
    expect(await alice.db.outboxOp.count({ where: { status: "PENDING" } })).toBe(1);
    hub.removeMember("2");
    await vi.waitFor(async () => expect((await alice.space("common")).access).toBe("REVOKED"));
    expect(alice.live!.link.state).toBe("removed");
    expect(await alice.db.project.count()).toBe(0);
    expect(await alice.db.planningItem.count()).toBe(0);
    expect((await alice.db.outboxOp.findMany()).map((o) => o.status)).toEqual(["QUARANTINED"]);
    expect(hub.entity("common", "card", "c1")?.data).toMatchObject({ title: "Ship it" });
  });

  it("access deleted purges the deleting admin's data too", async () => {
    await prepare(olive);
    await live(olive);
    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Unsent" } });
    await olive.engine.capture();
    hub.deleteSpace("common");
    await vi.waitFor(async () => expect((await olive.space("common")).access).toBe("REVOKED"));
    expect(await olive.db.project.count()).toBe(0);
    expect(await olive.db.planningItem.count()).toBe(0);
    expect((await olive.db.outboxOp.findMany()).map((o) => o.status)).toEqual(["QUARANTINED"]);
  });

  it("flapping: ten changed bursts with reconnects never run two syncSpace for one space", async () => {
    await prepare(olive, alice);
    const mt = new ManualTimers();
    await live(alice, { timers: mt });
    let active = 0;
    let max = 0;
    let calls = 0;
    const real = alice.engine.syncSpace.bind(alice.engine);
    vi.spyOn(alice.engine, "syncSpace").mockImplementation(async (s) => {
      calls++;
      active++;
      max = Math.max(max, active);
      try {
        await sleep(15);
        await real(s);
      } finally {
        active--;
      }
    });
    for (let i = 1; i <= 10; i++) {
      hub.inject("common", { type: "card", id: "c1", data: cardData("p1", `Edit ${i}`) });
      const socks = aliceSockets();
      for (const s of socks) s.deliver({ t: "changed", spaceId: "common", seq: String(hub.seq("common")) });
      mt.advance(100);
      await sleep(3);
      for (const s of socks) s.deliver({ t: "changed", spaceId: "common", seq: String(hub.seq("common")) });
      for (const s of socks) s.deliverClose(1006);
      mt.advance(30_000);
      await sleep(3);
    }
    await vi.waitFor(async () => expect(await title(alice)).toBe("Edit 10"), { timeout: 3000 });
    await sleep(100);
    expect(calls).toBeGreaterThan(0);
    expect(max).toBe(1);
  });

  it("changed during an engine cycle already running is not lost: retried until the cursor reaches the notified seq, no polling", async () => {
    await prepare(olive, alice);
    const mt = new ManualTimers();
    await live(alice, { timers: mt });
    const real = alice.client.pull.bind(alice.client);
    let reached!: () => void;
    const gotStale = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(alice.client, "pull").mockImplementationOnce(async (s, since) => {
      const r = await real(s, since); // the answer is computed before the edit exists
      reached();
      await gate;
      return r;
    });
    const inFlight = alice.engine.syncSpace(await alice.space("common"));
    await gotStale;
    hub.inject("common", { type: "card", id: "c1", data: cardData("p1", "Missed") });
    for (const s of aliceSockets()) s.deliver({ t: "changed", spaceId: "common", seq: String(hub.seq("common")) });
    mt.advance(100); // debounce: the live layer calls engine.syncSpace, which returns at once
    await sleep(30);
    expect(await title(alice)).toBe("Ship it");
    release();
    await inFlight;
    expect(await title(alice)).toBe("Ship it"); // the finished cycle never saw the edit
    await vi.waitFor(async () => {
      mt.advance(150);
      expect(await title(alice)).toBe("Missed");
    });
    expect((await alice.space("common")).hubCursor).toBe(hub.seq("common"));
  });

  it("a live space that failed is retried by the always-on 60 s poll even after the retries ran out", async () => {
    await prepare(olive, alice);
    const mt = new ManualTimers();
    const h = await live(alice, { timers: mt });
    await editCard(olive, "Hidden by 500");
    const pull = vi.spyOn(alice.client, "pull").mockRejectedValue(new HubError("unknown", "boom", { status: 500 }));
    for (const s of aliceSockets()) s.deliver({ t: "changed", spaceId: "common", seq: String(hub.seq("common")) });
    mt.advance(100);
    for (let i = 0; i < 8; i++) {
      await sleep(20);
      mt.advance(150); // exhaust the short retries
    }
    await sleep(20);
    expect((await alice.space("common")).lastError).toBeTruthy();
    expect(await title(alice)).toBe("Ship it");
    pull.mockRestore();
    expect(h.live()).toBe(true);
    mt.advance(60_000);
    await vi.waitFor(async () => expect(await title(alice)).toBe("Hidden by 500"));
  });

  it("startup: an op stranded in SENT goes back to PENDING and is delivered", async () => {
    await prepare(alice);
    await alice.db.planningItem.update({ where: { id: "c1" }, data: { title: "Crash edit" } });
    await alice.engine.capture();
    await alice.db.outboxOp.updateMany({ data: { status: "SENT" } });
    await live(alice);
    await vi.waitFor(async () => expect(hub.entity("common", "card", "c1")?.data).toMatchObject({ title: "Crash edit" }));
    expect(await alice.db.outboxOp.count()).toBe(0);
  });

  it("403 on read revokes the space; 404 on write revokes it and quarantines unsent ops", async () => {
    await prepare(alice, olive);
    hub.failNext(1, "forbidden");
    await alice.engine.syncSpace(await alice.space("common"));
    expect((await alice.space("common")).access).toBe("REVOKED");
    expect(await alice.db.project.count()).toBe(0);

    await olive.db.planningItem.update({ where: { id: "c1" }, data: { title: "Unsent" } });
    await olive.engine.capture();
    vi.spyOn(olive.client, "push").mockRejectedValueOnce(new HubError("not-found", "gone", { status: 404 }));
    await olive.engine.pushSpace(await olive.space("common"));
    expect((await olive.space("common")).access).toBe("REVOKED");
    expect((await olive.db.outboxOp.findMany()).map((o) => o.status)).toEqual(["QUARANTINED"]);
  });

  it("a non-HubError failure still backs the space off", async () => {
    await prepare(alice);
    await alice.db.space.updateMany({ data: { nextPollAt: null } });
    vi.spyOn(alice.client, "pull").mockRejectedValueOnce(new Error("disk full"));
    await alice.engine.pullSpace(await alice.space("common")).catch(() => {});
    const sp = await alice.space("common");
    expect(sp.lastError).toBe("disk full");
    expect(sp.nextPollAt).not.toBeNull();
  });

  it("newer hub schema refused: checkHubHealth throws kind schema and no Space is created", async () => {
    hub.setSchema(2);
    await expect(checkHubHealth(hub.origin())).rejects.toMatchObject({ kind: "schema" });
    expect(await alice.db.space.count()).toBe(0);
  });

  it("tick() leaves hub spaces to the live stream while live, and polls them when not", async () => {
    await prepare(alice);
    const h = await live(alice);
    await alice.db.space.updateMany({ data: { nextPollAt: null } });
    expect((await alice.engine.tick()).polled).toBe(0);
    h.stop();
    expect(h.live()).toBe(false);
    expect((await alice.engine.tick()).polled).toBeGreaterThan(0);
  });
});

describe("consistency delay", () => {
  it("GitHub numbers are unchanged when no hub is given", () => {
    expect(expectedConsistencyDelaySeconds(30)).toEqual({ typical: 17, worst: 144 });
    expect(expectedConsistencyDelaySeconds(60)).toEqual({ typical: 32, worst: 144 });
  });
  it("hub live is about 1 s, otherwise up to a minute", () => {
    expect(expectedConsistencyDelaySeconds(30, { live: true })).toEqual({ typical: 1, worst: 1, label: "about 1 s (live)" });
    expect(expectedConsistencyDelaySeconds(30, { live: false })).toEqual({ typical: 30, worst: 60, label: "up to 1 min (reconnecting)" });
  });
});
