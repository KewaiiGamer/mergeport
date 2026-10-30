import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncHubSpaces } from "@/lib/hub/spaces";
import type { HubClient } from "@/lib/hub/types";
import { SyncEngine } from "@/lib/sync/engine";
import { clock } from "../harness";
import { FakeHub } from "./fake-hub";
import { makeHubClient, projectData, type HubTestClient } from "./harness";

/** A hub client whose pull / push answers only after the test releases it. */
function gated(inner: HubClient) {
  let release: () => void = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  let reached: () => void = () => {};
  const started = new Promise<void>((ok) => (reached = ok));
  const client: HubClient = {
    me: () => inner.me(),
    snapshot: (id) => inner.snapshot(id),
    pull: async (id, since) => {
      reached();
      await gate;
      return inner.pull(id, since);
    },
    push: async (id, ops) => {
      reached();
      await gate;
      return inner.push(id, ops);
    },
  };
  return { client, started, release: () => release() };
}

let hub: FakeHub;
let c: HubTestClient;
beforeEach(async () => {
  hub = new FakeHub();
  hub.addMember("1", "olive", "OWNER");
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  await hub.listen();
  c = await makeHubClient(hub, 2n, "alice");
  await syncHubSpaces(c.db, c.engine, await c.client.me());
});
afterEach(async () => {
  await c.close();
  await hub.close();
});

const engineWith = (client: HubClient) =>
  new SyncEngine({
    db: c.db, actor: c.actor, now: clock.now, random: () => 0.5, hub: () => client,
    store: () => {
      throw new Error("GitHub store used in a hub test");
    },
  });

describe("revokeSpace during an in-flight hub request", () => {
  it("a pull that answers after the revoke writes nothing and the space stays revoked", async () => {
    hub.inject("common", { type: "project", id: "p1", data: projectData("Roadmap") });
    const g = gated(c.client);
    const engine = engineWith(g.client);
    const space = await c.space("common");
    const pull = engine.pullSpace(space);
    await g.started;
    await engine.revokeSpace(space.id, "removed");
    g.release();
    await expect(pull).resolves.toEqual({ changed: false, applied: 0 });

    expect(await c.db.project.count()).toBe(0);
    expect(await c.db.syncEntity.count({ where: { spaceId: space.id } })).toBe(0);
    expect(await c.space("common")).toMatchObject({ access: "REVOKED", hubCursor: 0n, lastError: "removed" });
  });

  it("a push that answers after the revoke records nothing; its operations stay quarantined", async () => {
    const space = await c.space("common");
    await c.db.outboxOp.create({ data: { id: "op1", spaceId: space.id, entityType: "project", entityId: "p1", kind: "UPSERT", data: projectData("Roadmap"), baseVersion: 0 } });
    const g = gated(c.client);
    const engine = engineWith(g.client);
    const push = engine.pushSpace(space);
    await g.started;
    await engine.revokeSpace(space.id, "removed");
    g.release();
    await expect(push).resolves.toEqual({ sent: 0 });

    expect(await c.db.outboxOp.findMany({ where: { spaceId: space.id } })).toEqual([expect.objectContaining({ id: "op1", status: "QUARANTINED" })]);
    expect(await c.db.syncEntity.count({ where: { spaceId: space.id } })).toBe(0);
    expect((await c.space("common")).access).toBe("REVOKED");
    expect(hub.entity("common", "project", "p1")?.version).toBe(1); // the hub applied it; the retry after reinstatement is idempotent
  });

  it("a stale answer never moves a quarantined operation back to PENDING", async () => {
    const space = await c.space("common");
    hub.inject("common", { type: "project", id: "p1", data: projectData("Roadmap") });
    await c.db.outboxOp.create({ data: { id: "op1", spaceId: space.id, entityType: "project", entityId: "p1", kind: "UPSERT", data: projectData("Roadmap 2"), baseVersion: 0 } });
    const g = gated(c.client);
    const engine = engineWith(g.client);
    const push = engine.pushSpace(space);
    await g.started;
    // Write access removed mid-flight (not the whole space): the SENT operation is quarantined.
    await c.db.outboxOp.updateMany({ where: { spaceId: space.id }, data: { status: "QUARANTINED", error: "Write access was removed" } });
    g.release();
    await push;
    expect((await c.db.outboxOp.findUniqueOrThrow({ where: { id: "op1" } })).status).toBe("QUARANTINED");
  });
});
