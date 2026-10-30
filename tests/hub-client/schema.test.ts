import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";

const db = createPrisma(path.resolve(".data", `hub-client-schema-${process.pid}.db`));
afterAll(() => db.$disconnect());

const base = { remoteId: "r", teamRemoteId: "t", kind: "COMMON" as const, name: "n" };

describe("hub client schema", () => {
  it("creates a GitHub space with defaults", async () => {
    const s = await db.space.create({ data: { ...base, repoOwner: "acme", repoName: "coord" } });
    expect(s.backend).toBe("GITHUB");
    expect(s.hubCursor).toBe(0n);
    expect(s.hubSpaceId).toBe("");
  });

  it("allows HUB spaces with different hubSpaceId and rejects duplicates", async () => {
    await db.space.create({ data: { ...base, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: "common" } });
    await db.space.create({ data: { ...base, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: "other" } });
    await expect(db.space.create({ data: { ...base, backend: "HUB", repoOwner: "", repoName: "", hubSpaceId: "common" } })).rejects.toThrow();
  });

  it("still rejects a duplicate GitHub (owner, name)", async () => {
    await expect(db.space.create({ data: { ...base, repoOwner: "acme", repoName: "coord" } })).rejects.toThrow();
  });

  it("defaults TeamConfig to GITHUB without hubOrigin", async () => {
    const t = await db.teamConfig.create({ data: {} });
    expect(t.backend).toBe("GITHUB");
    expect(t.hubOrigin).toBeNull();
  });

  it("round-trips a HubSession cipher", async () => {
    await db.hubSession.create({ data: { origin: "https://hub.example", cipher: "v1.abc.def.ghi", githubId: 42n, login: "alice" } });
    const s = await db.hubSession.findUniqueOrThrow({ where: { id: "session" } });
    expect(s.cipher).toBe("v1.abc.def.ghi");
    expect(s.githubId).toBe(42n);
  });
});
