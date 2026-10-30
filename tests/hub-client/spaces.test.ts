import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncHubSpaces } from "@/lib/hub/spaces";
import { FakeHub } from "./fake-hub";
import { makeHubClient, type HubTestClient } from "./harness";

let hub: FakeHub;
let c: HubTestClient;
beforeEach(async () => {
  hub = new FakeHub();
  hub.addMember("1", "olive", "OWNER");
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  hub.createSpace("r1", "RESTRICTED", "Design", ["2"]);
  await hub.listen();
  c = await makeHubClient(hub, 2n, "alice");
});
afterEach(async () => {
  await c.close();
  await hub.close();
});

describe("syncHubSpaces", () => {
  it("turns a GitHub-default TeamConfig into HUB and records the origin", async () => {
    await c.db.teamConfig.update({ where: { id: "team" }, data: { backend: "GITHUB", hubOrigin: null } });
    await syncHubSpaces(c.db, c.engine, await c.client.me(), "http://hub.test:1");
    expect(await c.db.teamConfig.findUniqueOrThrow({ where: { id: "team" } })).toMatchObject({ backend: "HUB", hubOrigin: "http://hub.test:1" });
    await c.db.teamConfig.delete({ where: { id: "team" } });
    await syncHubSpaces(c.db, c.engine, await c.client.me(), "http://hub.test:2");
    expect(await c.db.teamConfig.findUniqueOrThrow({ where: { id: "team" } })).toMatchObject({ backend: "HUB", hubOrigin: "http://hub.test:2" });
  });

  it("creates, updates canWrite, and revokes vanished spaces; commonSpaceId set", async () => {
    const r1 = await syncHubSpaces(c.db, c.engine, await c.client.me());
    expect(r1).toEqual({ added: expect.arrayContaining(["common", "r1"]), removed: [] });
    const common = await c.space("common");
    expect(common).toMatchObject({ backend: "HUB", remoteId: "common", teamRemoteId: "team", repoOwner: "", repoName: "", canWrite: true, canAdmin: false, access: "OK", kind: "COMMON" });
    expect((await c.db.teamConfig.findUniqueOrThrow({ where: { id: "team" } })).commonSpaceId).toBe(common.id);

    hub.setRole("2", "READER");
    const r2 = await syncHubSpaces(c.db, c.engine, await c.client.me());
    expect(r2.added).toEqual([]);
    expect((await c.space("r1")).canWrite).toBe(false);

    hub.deleteSpace("r1");
    const r3 = await syncHubSpaces(c.db, c.engine, await c.client.me());
    expect(r3.removed).toEqual(["r1"]);
    const gone = await c.space("r1");
    expect(gone.access).toBe("REVOKED");
    expect(gone.lastError).toBe("You no longer have access to this space");
    expect((await c.space("common")).access).toBe("OK");
  });
});
