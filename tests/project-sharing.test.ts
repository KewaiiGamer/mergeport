import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { commonSpaceIdForSharing } from "@/lib/services/project-sharing";

const space = (o: { kind: "COMMON" | "RESTRICTED"; canWrite: boolean; access?: "OK" | "REVOKED"; name?: string }) =>
  db.space.create({ data: { remoteId: o.name ?? o.kind, teamRemoteId: "t", kind: o.kind, name: o.name ?? o.kind, repoOwner: "", repoName: "", backend: "HUB", hubSpaceId: o.name ?? o.kind, canWrite: o.canWrite, access: o.access ?? "OK" } });

beforeEach(async () => {
  await db.space.deleteMany({});
});
afterEach(async () => {
  await db.space.deleteMany({});
});

describe("the project form's Sharing checkbox", () => {
  it("means the team's common space when this person can write to it", async () => {
    const common = await space({ kind: "COMMON", canWrite: true });
    await space({ kind: "RESTRICTED", canWrite: true, name: "secret" });
    expect(await commonSpaceIdForSharing(db)).toBe(common.id);
  });

  it("is refused when there is no team space at all", async () => {
    await expect(commonSpaceIdForSharing(db)).rejects.toBeInstanceOf(ValidationError);
  });

  it("is refused when the team space is read-only or revoked", async () => {
    await space({ kind: "COMMON", canWrite: false });
    await expect(commonSpaceIdForSharing(db)).rejects.toBeInstanceOf(ValidationError);
    await db.space.deleteMany({});
    await space({ kind: "COMMON", canWrite: true, access: "REVOKED" });
    await expect(commonSpaceIdForSharing(db)).rejects.toBeInstanceOf(ValidationError);
  });

  it("never picks a restricted space, however writable", async () => {
    await space({ kind: "RESTRICTED", canWrite: true });
    await expect(commonSpaceIdForSharing(db)).rejects.toBeInstanceOf(ValidationError);
  });
});
