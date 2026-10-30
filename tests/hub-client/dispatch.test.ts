import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrisma } from "@/lib/db";
import { SyncEngine } from "@/lib/sync/engine";

const db = createPrisma(path.resolve(".data", `hub-client-dispatch-${process.pid}.db`));
afterAll(() => db.$disconnect());

const base = { remoteId: "r", teamRemoteId: "t", kind: "COMMON" as const, name: "n" };
const actor = { id: 1n, login: "alice" };

function engine(withHub: boolean) {
  const store = vi.fn(() => {
    throw new Error("store called");
  });
  const hub = vi.fn(() => ({}) as never);
  const e = new SyncEngine({ db, store: store as never, actor, ...(withHub ? { hub } : {}) });
  return { e, store, hub };
}

describe("engine backend dispatch", () => {
  it("pullSpace on a HUB space uses hub, never store", async () => {
    const space = await db.space.create({ data: { ...base, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: "d1" } });
    const { e, store, hub } = engine(true);
    expect(await e.pullSpace(space)).toEqual({ changed: false, applied: 0 });
    expect(store).not.toHaveBeenCalled();
    expect(hub).toHaveBeenCalled();
  });

  it("a GITHUB space never calls hub", async () => {
    const space = await db.space.create({ data: { ...base, repoOwner: "acme", repoName: "dispatch" } });
    const { e, store, hub } = engine(true);
    await expect(e.pullSpace(space)).rejects.toThrow(/store called/);
    expect(store).toHaveBeenCalled();
    expect(hub).not.toHaveBeenCalled();
  });

  it("pushSpace on a HUB space without hub dep rejects", async () => {
    const space = await db.space.create({ data: { ...base, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: "d2" } });
    const { e } = engine(false);
    await expect(e.pushSpace(space)).rejects.toThrow(/No hub client configured/);
  });
});
