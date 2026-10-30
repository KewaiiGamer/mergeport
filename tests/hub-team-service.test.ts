import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrisma } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { HubForbidden, HubRequestError, HubUnauthorized } from "@/lib/hub/ports";
import { httpHubAdmin, hubSessionPort } from "@/lib/hub/ports-impl";
import { HubTeamService } from "@/lib/team/hub-service";
import { FAKE_SESSION, startFakeHub, type FakeMember } from "./fake-hub";

const people: FakeMember[] = [
  { githubId: "1", login: "boss", role: "OWNER" },
  { githubId: "2", login: "adm", role: "ADMIN" },
  { githubId: "3", login: "mem", role: "MEMBER" },
];
let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function setup(actor: string, extra: Parameters<typeof startFakeHub>[0] = {}, token: string | null = FAKE_SESSION) {
  const hub = await startFakeHub({ members: people.map((m) => ({ ...m })), githubId: actor, ...extra });
  stop = hub.stop;
  const svc = new HubTeamService(httpHubAdmin(hub.origin, async () => token), actor);
  return { hub, svc };
}
const admin = (r: { path: string }[]) => r.filter((x) => x.path.startsWith("/admin/"));

describe("HubTeamService", () => {
  it("lists members with roles", async () => {
    const { svc } = await setup("2");
    const o = await svc.overview();
    expect(o.teamName).toBe("Fake Team");
    expect(o.members.map((m) => [m.login, m.role])).toEqual([["boss", "OWNER"], ["adm", "ADMIN"], ["mem", "MEMBER"]]);
    expect(o.canAdmin).toBe(true);
  });

  it("MEMBER cannot invite and nothing reaches /admin", async () => {
    const { hub, svc } = await setup("3");
    expect((await svc.overview()).canAdmin).toBe(false);
    await expect(svc.invite("someone")).rejects.toThrow(ValidationError);
    await expect(svc.invite("someone")).rejects.toThrow("Only admins can");
    expect(admin(hub.requests)).toHaveLength(0);
  });

  it("adminSpaces returns spaces with members for an admin; a MEMBER never reaches /admin", async () => {
    const { hub, svc } = await setup("2", { spaceMembers: { common: [{ githubId: "1", canWrite: true }] } });
    const s = await svc.adminSpaces();
    expect(s).toEqual([{ id: "common", kind: "COMMON", name: "Common", members: [{ githubId: "1", canWrite: true }] }]);
    const m = await setup("3");
    await expect(m.svc.adminSpaces()).rejects.toThrow("Only admins can");
    expect(admin(m.hub.requests)).toHaveLength(0);
    void hub;
  });

  it("promoted after a cached MEMBER overview still succeeds", async () => {
    const { hub, svc } = await setup("3");
    expect((await svc.overview()).canAdmin).toBe(false);
    hub.members.find((m) => m.githubId === "3")!.role = "ADMIN";
    await svc.invite("someone");
    expect(hub.requests.some((r) => r.path === "/admin/invites")).toBe(true);
  });

  it("clears the cache after a mutation", async () => {
    const { hub, svc } = await setup("1");
    await svc.invite("one");
    const n = () => hub.requests.filter((r) => r.path === "/me").length;
    const before = n();
    await svc.invite("two");
    expect(n()).toBe(before + 1);
  });

  it("rejects an unknown role and a blank space name", async () => {
    const { hub, svc } = await setup("1");
    await expect(svc.invite("x", "OWNER" as never)).rejects.toThrow(ValidationError);
    await expect(svc.updateSpace("s1", { name: "  " })).rejects.toThrow(ValidationError);
    expect(admin(hub.requests)).toHaveLength(0);
  });

  it("ADMIN invites @Octo-Cat as octo-cat", async () => {
    const { hub, svc } = await setup("2");
    await svc.invite("  @Octo-Cat ");
    expect(hub.requests.find((r) => r.path === "/admin/invites")?.body).toEqual({ githubLogin: "octo-cat", role: "MEMBER" });
  });

  it("rejects invalid logins without a request", async () => {
    const { hub, svc } = await setup("2");
    for (const bad of ["", "@", "-x", "a b", "a".repeat(40), "a/b"]) await expect(svc.invite(bad)).rejects.toThrow(ValidationError);
    expect(admin(hub.requests)).toHaveLength(0);
  });

  it("OWNER cannot be removed or re-roled, nor yourself", async () => {
    const { hub, svc } = await setup("2");
    await svc.overview();
    await expect(svc.removeMember("1")).rejects.toThrow(ValidationError);
    await expect(svc.changeRole("1", "MEMBER")).rejects.toThrow(ValidationError);
    await expect(svc.changeRole("2", "MEMBER")).rejects.toThrow("your own role");
    expect(admin(hub.requests)).toHaveLength(0);
  });

  it("changes a role and removes a member", async () => {
    const { hub, svc } = await setup("1");
    await svc.changeRole("3", "READER");
    await svc.removeMember("3");
    expect(hub.requests.find((r) => r.method === "PATCH")?.body).toEqual({ role: "READER" });
    expect(hub.requests.some((r) => r.method === "DELETE" && r.path === "/admin/members/3")).toBe(true);
  });

  it("hub refuses an ADMIN touching an ADMIN with HubForbidden", async () => {
    const { svc } = await setup("2");
    await expect(svc.removeMember("2")).rejects.toThrow(HubForbidden);
  });

  it("deleteSpace needs confirmation", async () => {
    const { hub, svc } = await setup("1");
    const sp = await svc.createSpace("Secret", []);
    const before = admin(hub.requests).length;
    await expect(svc.deleteSpace(sp.id, { confirmed: false })).rejects.toThrow("Deleting this space removes its projects, cards and tasks from every member's computer.");
    expect(admin(hub.requests)).toHaveLength(before);
    await svc.deleteSpace(sp.id, { confirmed: true });
    expect(hub.requests.at(-1)).toMatchObject({ method: "DELETE", path: `/admin/spaces/${sp.id}` });
  });

  it("maps 401 and 403", async () => {
    const a = await setup("1", {}, "wrong-token");
    await expect(a.svc.overview()).rejects.toThrow(HubUnauthorized);
    await stop?.();
    const b = await setup("1", { forceStatus: 403 });
    await expect(b.svc.overview()).rejects.toThrow(HubForbidden);
  });

  it("no stored token is a 401", async () => {
    const { svc } = await setup("1", {}, null);
    await expect(svc.overview()).rejects.toThrow(HubUnauthorized);
  });

  it("429 carries Retry-After and no token", async () => {
    const { svc } = await setup("1", { forceStatus: 429 });
    const e = await svc.overview().catch((x) => x);
    expect(e).toBeInstanceOf(HubRequestError);
    expect(e.retryAfter).toBe("7");
    expect(String(e.message)).not.toContain(FAKE_SESSION);
  });

  it("signOut succeeds with the hub down and removes the session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubsvc-"));
    const db = path.join(dir, "mergeport.db");
    await hubSessionPort.save(db, { origin: "http://127.0.0.1:1", token: FAKE_SESSION, githubId: "1", login: "boss" });
    expect((await hubSessionPort.read(db))?.token).toBe(FAKE_SESSION);
    const svc = new HubTeamService(httpHubAdmin("http://127.0.0.1:1", async () => FAKE_SESSION), "1");
    await expect(svc.signOut(db)).resolves.toEqual({ switchTo: "github" });
    expect(await hubSessionPort.read(db)).toBeNull();
    // The row itself is gone (not merely undecryptable): nothing of the token remains in the database.
    const prisma = createPrisma(db, { migrate: false });
    try {
      expect(await prisma.hubSession.count()).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("HubTeamService reinstatement", () => {
  const stub = (role: "OWNER" | "ADMIN") => {
    const calls: string[] = [];
    const self = { githubId: "1", login: "boss", name: null, avatarUrl: null, role, status: "ACTIVE" as const };
    const api = {
      me: async () => ({ member: self, team: { name: "T" }, members: [self], spaces: [] }),
      removedMembers: async () => [{ githubId: "9", login: "gone", name: null, avatarUrl: null, role: "MEMBER" as const, status: "REMOVED" as const }],
      reinstateMember: async (id: string, r: string) => void calls.push(`reinstate:${id}:${r}`),
    } as unknown as import("@/lib/hub/ports").HubAdminApi;
    return { svc: new HubTeamService(api, "1"), calls };
  };

  it("the owner sees removed members and reinstates one with a chosen role", async () => {
    const { svc, calls } = stub("OWNER");
    expect((await svc.removedMembers()).map((m) => m.login)).toEqual(["gone"]);
    await svc.reinstateMember("9", "READER");
    expect(calls).toEqual(["reinstate:9:READER"]);
    await expect(svc.reinstateMember("9", "OWNER")).rejects.toThrow(ValidationError);
  });

  it("an admin sees nothing and cannot reinstate, before any request is sent", async () => {
    const { svc, calls } = stub("ADMIN");
    expect(await svc.removedMembers()).toEqual([]);
    await expect(svc.reinstateMember("9", "MEMBER")).rejects.toThrow(ValidationError);
    expect(calls).toEqual([]);
  });
});
