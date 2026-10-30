import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMember } from "../../hub/src/auth";
import { requireRole, spaceAccess } from "../../hub/src/authz";
import { signInAs, startTestHub, type TestHub } from "./harness";

let hub: TestHub;
beforeEach(async () => {
  hub = await startTestHub();
});
afterEach(async () => {
  await hub.close();
});

type Spec = [id: bigint, login: string, role: string];

/** Owner (id 1, "olive") signs in first; others are invited through the API, then sign in. Returns tokens by login. */
async function setup(...others: Spec[]): Promise<Record<string, string>> {
  const tokens: Record<string, string> = { olive: await signInAs(hub, 1n, "olive") };
  for (const [id, login, role] of others) {
    hub.github.addUser({ id, login });
    const inv = await hub.api(tokens.olive)("POST", "/admin/invites", { githubLogin: login, role });
    expect(inv.status, `invite ${login}`).toBe(201);
    tokens[login] = await signInAs(hub, id, login);
  }
  return tokens;
}
const roleOf = (id: bigint) => (hub.db.prepare("SELECT role FROM member WHERE github_id = ?").get(id) as { role: string }).role;
const spacesOf = async (token: string) =>
  (await hub.api(token)("GET", "/me")).body.spaces as { id: string; kind: string; name: string; canWrite: boolean; seq: string }[];

describe("invites and roles", () => {
  it("READER cannot POST /admin/invites (403)", async () => {
    const t = await setup([2n, "rita", "READER"]);
    const r = await hub.api(t.rita)("POST", "/admin/invites", { githubLogin: "bob", role: "MEMBER" });
    expect(r.status).toBe(403);
  });

  it("MEMBER cannot reach any admin route", async () => {
    const t = await setup([2n, "mia", "MEMBER"]);
    for (const [m, p] of [
      ["GET", "/admin/members"],
      ["GET", "/admin/spaces"],
      ["DELETE", "/admin/members/1"],
    ]) {
      expect((await hub.api(t.mia)(m, p)).status, `${m} ${p}`).toBe(403);
    }
  });

  it("anonymous admin call is 401", async () => {
    await setup();
    expect((await hub.api()("GET", "/admin/members")).status).toBe(401);
  });

  it("ADMIN cannot invite ADMIN, OWNER can", async () => {
    const t = await setup([2n, "adam", "ADMIN"]);
    hub.github.addUser({ id: 30n, login: "bob" });
    hub.github.addUser({ id: 31n, login: "carol" });
    expect((await hub.api(t.adam)("POST", "/admin/invites", { githubLogin: "bob", role: "ADMIN" })).status).toBe(403);
    const okMember = await hub.api(t.adam)("POST", "/admin/invites", { githubLogin: "bob", role: "MEMBER" });
    expect(okMember.status).toBe(201);
    expect(okMember.body.invite).toMatchObject({ githubLogin: "bob", role: "MEMBER" });
    const okAdmin = await hub.api(t.olive)("POST", "/admin/invites", { githubLogin: "carol", role: "ADMIN" });
    expect(okAdmin.status).toBe(201);
    expect(okAdmin.body.invite.role).toBe("ADMIN");
  });

  it("invite rejects OWNER role, bad login and already-active login", async () => {
    const t = await setup([2n, "mia", "MEMBER"]);
    const api = hub.api(t.olive);
    expect((await api("POST", "/admin/invites", { githubLogin: "bob", role: "OWNER" })).status).toBe(400);
    expect((await api("POST", "/admin/invites", { githubLogin: "not a login!", role: "MEMBER" })).status).toBe(400);
    expect((await api("POST", "/admin/invites", { githubLogin: "MIA", role: "MEMBER" })).status).toBe(409);
  });

  it("GET /admin/members lists members with string ids", async () => {
    const t = await setup([2n, "mia", "MEMBER"]);
    const r = await hub.api(t.olive)("GET", "/admin/members");
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: { githubId: string; role: string }) => [m.githubId, m.role])).toEqual([
      ["1", "OWNER"],
      ["2", "MEMBER"],
    ]);
  });
});

describe("removing members", () => {
  it("OWNER cannot be removed (409)", async () => {
    const t = await setup([2n, "adam", "ADMIN"]);
    expect((await hub.api(t.adam)("DELETE", "/admin/members/1")).status).toBe(409);
    expect((await hub.api(t.olive)("DELETE", "/admin/members/1")).status).toBe(409);
    expect(roleOf(1n)).toBe("OWNER");
  });

  it("ADMIN cannot remove ADMIN, but can remove MEMBER", async () => {
    const t = await setup([2n, "adam", "ADMIN"], [3n, "mia", "MEMBER"], [4n, "adele", "ADMIN"]);
    expect((await hub.api(t.adam)("DELETE", "/admin/members/4")).status).toBe(403);
    expect((await hub.api(t.adam)("DELETE", "/admin/members/3")).status).toBe(204);
    expect((await hub.api(t.olive)("DELETE", "/admin/members/4")).status).toBe(204);
  });

  it("removal revokes sessions and space membership; old token 401, new device flow 403 removed", async () => {
    const t = await setup([2n, "mia", "MEMBER"]);
    const sp = await hub.api(t.olive)("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "2", canWrite: true }] });
    expect(sp.status).toBe(201);
    expect((await hub.api(t.mia)("GET", "/me")).status).toBe(200);

    expect((await hub.api(t.olive)("DELETE", "/admin/members/2")).status).toBe(204);

    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM session WHERE github_id = 2").get()).toEqual({ n: 0 });
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM space_member WHERE github_id = 2").get()).toEqual({ n: 0 });
    expect(hub.db.prepare("SELECT status FROM member WHERE github_id = 2").get()).toEqual({ status: "REMOVED" });
    // The revoked token is unknown now. A session that somehow survived gets 403 removed (covered in auth.test.ts).
    expect((await hub.api(t.mia)("GET", "/me")).status).toBe(401);
    const s = (await hub.api()("POST", "/auth/device/start")).body;
    hub.github.authorize(s.userCode, 2n);
    const again = await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: s.pollSecret });
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ reason: "removed" });
  });

  it("bad ids are 400, unknown id is 404", async () => {
    const t = await setup();
    for (const bad of ["abc", "1.5", "-1", "99999999999999999999999"]) {
      expect((await hub.api(t.olive)("DELETE", `/admin/members/${bad}`)).status, bad).toBe(400);
    }
    expect((await hub.api(t.olive)("DELETE", "/admin/members/777")).status).toBe(404);
  });

  it("handles ids beyond 2^53", async () => {
    const big = 9007199254740993n;
    const t = await setup([big, "bigmia", "MEMBER"]);
    expect((await hub.api(t.olive)("DELETE", `/admin/members/${big}`)).status).toBe(204);
    expect(hub.db.prepare("SELECT status FROM member WHERE github_id = ?").get(big)).toEqual({ status: "REMOVED" });
  });
});

describe("/me", () => {
  it("every active member sees the member list in /me", async () => {
    const t = await setup([2n, "adam", "ADMIN"], [3n, "mia", "MEMBER"], [4n, "rita", "READER"]);
    for (const [login, tok] of Object.entries(t)) {
      const me = await hub.api(tok)("GET", "/me");
      expect(me.status, login).toBe(200);
      expect(me.body.members.map((m: { login: string }) => m.login).sort(), login).toEqual(["adam", "mia", "olive", "rita"]);
    }
  });

  it("restricted space invisible in /me to non-member, visible with canWrite per space_member and role", async () => {
    const t = await setup([12n, "mia", "MEMBER"], [13n, "max", "MEMBER"], [14n, "out", "MEMBER"]);
    const sp = await hub.api(t.olive)("POST", "/admin/spaces", {
      name: "Design",
      members: [
        { githubId: "12", canWrite: true },
        { githubId: "13", canWrite: false },
      ],
    });
    expect(sp.status).toBe(201);
    const id = sp.body.space.id as string;

    expect((await spacesOf(t.out)).map((s) => s.id)).toEqual(["common"]);
    expect((await spacesOf(t.mia)).find((s) => s.id === id)).toMatchObject({ kind: "RESTRICTED", name: "Design", canWrite: true });
    expect((await spacesOf(t.max)).find((s) => s.id === id)).toMatchObject({ canWrite: false });
    const common = (await spacesOf(t.mia)).find((s) => s.id === "common")!;
    expect(common).toMatchObject({ kind: "COMMON", name: "Workspace", canWrite: true });
    expect(common.seq).toBe("0");
  });

  it("owner bootstrap creates the COMMON space", async () => {
    await setup();
    expect(hub.db.prepare("SELECT id, kind, name FROM space").all()).toEqual([{ id: "common", kind: "COMMON", name: "Workspace" }]);
  });
});

describe("space access", () => {
  it("READER in a restricted space with can_write=1 still cannot write (role floor)", async () => {
    const t = await setup([2n, "rita", "READER"]);
    const sp = await hub.api(t.olive)("POST", "/admin/spaces", { name: "RO", members: [{ githubId: "2", canWrite: true }] });
    expect(sp.status).toBe(201);
    const spaces = await spacesOf(t.rita);
    expect(spaces.find((s) => s.id === sp.body.space.id)).toMatchObject({ canWrite: false });
    expect(spaces.find((s) => s.id === "common")).toMatchObject({ canWrite: false });
    // The stored flag is still 1: the floor is applied at read time, so promoting the member restores write.
    expect(hub.db.prepare("SELECT can_write FROM space_member WHERE github_id = 2").get()).toEqual({ can_write: 1 });
    const access = spaceAccess(hub.db, getMember(hub.db, 2n)!, sp.body.space.id);
    expect(access).toEqual({ canRead: true, canWrite: false });
  });

  it("spaceAccess: unknown space and removed member have no access", async () => {
    await setup();
    const owner = getMember(hub.db, 1n)!;
    expect(spaceAccess(hub.db, owner, "common")).toEqual({ canRead: true, canWrite: true });
    expect(spaceAccess(hub.db, owner, "nope")).toEqual({ canRead: false, canWrite: false });
    expect(spaceAccess(hub.db, { ...owner, status: "REMOVED" }, "common")).toEqual({ canRead: false, canWrite: false });
  });

  it("requireRole enforces READER < MEMBER < ADMIN < OWNER", () => {
    const m = (role: string) => ({ githubId: 1n, login: "x", name: null, avatarUrl: null, role, status: "ACTIVE" });
    expect(() => requireRole(m("ADMIN"), "ADMIN")).not.toThrow();
    expect(() => requireRole(m("OWNER"), "ADMIN")).not.toThrow();
    expect(() => requireRole(m("MEMBER"), "ADMIN")).toThrow(/forbidden/);
    expect(() => requireRole(m("READER"), "MEMBER")).toThrow();
    expect(() => requireRole(m("BOGUS"), "READER")).toThrow();
  });
});

describe("admin spaces", () => {
  it("DELETE /admin/spaces/common is 409", async () => {
    const t = await setup();
    expect((await hub.api(t.olive)("DELETE", "/admin/spaces/common")).status).toBe(409);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM space WHERE id = 'common'").get()).toEqual({ n: 1 });
  });

  it("COMMON accepts a name change but not members", async () => {
    const t = await setup();
    const api = hub.api(t.olive);
    expect((await api("PATCH", "/admin/spaces/common", { members: [] })).status).toBe(400);
    const r = await api("PATCH", "/admin/spaces/common", { name: "Everyone" });
    expect(r.status).toBe(200);
    expect(r.body.space).toMatchObject({ id: "common", name: "Everyone" });
  });

  it("create, list, patch members, delete cascades entities, events and members", async () => {
    const t = await setup([2n, "mia", "MEMBER"], [3n, "adam", "ADMIN"]);
    const api = hub.api(t.adam);
    const c = await api("POST", "/admin/spaces", { name: "Proj", members: [{ githubId: "2", canWrite: true }] });
    expect(c.status).toBe(201);
    const id = c.body.space.id as string;
    expect((await api("GET", "/admin/spaces")).body.spaces.find((s: { id: string }) => s.id === id)).toMatchObject({
      kind: "RESTRICTED",
      name: "Proj",
      members: [{ githubId: "2", canWrite: true }],
    });

    const p = await api("PATCH", `/admin/spaces/${id}`, { name: "Proj2", members: [{ githubId: "3", canWrite: false }] });
    expect(p.status).toBe(200);
    expect(p.body.space).toMatchObject({ name: "Proj2", members: [{ githubId: "3", canWrite: false }] });

    hub.db.prepare("INSERT INTO entity (space_id, type, entity_id, version, data, updated_at, updated_by, seq) VALUES (?, 't', 'e', 1, '{}', 'x', 1, 1)").run(id);
    hub.db.prepare("INSERT INTO entity_event (space_id, seq, type, entity_id, version, data, actor_github_id, at) VALUES (?, 1, 't', 'e', 1, '{}', 1, 'x')").run(id);
    expect((await api("DELETE", `/admin/spaces/${id}`)).status).toBe(204);
    for (const tbl of ["space", "space_member", "entity", "entity_event"]) {
      const col = tbl === "space" ? "id" : "space_id";
      expect(hub.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE ${col} = ?`).get(id), tbl).toEqual({ n: 0 });
    }
    expect((await api("DELETE", `/admin/spaces/${id}`)).status).toBe(404);
  });

  it("rejects non-active members and bad bodies", async () => {
    const t = await setup();
    const api = hub.api(t.olive);
    expect((await api("POST", "/admin/spaces", { name: "X", members: [{ githubId: "999", canWrite: true }] })).status).toBe(400);
    expect((await api("POST", "/admin/spaces", { name: "", members: [] })).status).toBe(400);
    expect((await api("POST", "/admin/spaces", { name: "X", members: [{ githubId: "abc", canWrite: true }] })).status).toBe(400);
  });
});

describe("ownership and role changes", () => {
  it("ownership transfer swaps roles", async () => {
    const t = await setup([2n, "adam", "ADMIN"]);
    expect((await hub.api(t.adam)("PATCH", "/admin/members/2", { role: "OWNER" })).status).toBe(403);
    const r = await hub.api(t.olive)("PATCH", "/admin/members/2", { role: "OWNER" });
    expect(r.status).toBe(200);
    expect(roleOf(2n)).toBe("OWNER");
    expect(roleOf(1n)).toBe("ADMIN");
    expect(hub.db.prepare("SELECT owner_github_id AS o FROM team").get()).toEqual({ o: 2 });
    // old owner is a plain ADMIN now and cannot demote the new owner
    expect((await hub.api(t.olive)("PATCH", "/admin/members/2", { role: "MEMBER" })).status).toBe(409);
  });

  it("only OWNER may set or unset ADMIN; ADMIN may change MEMBER/READER", async () => {
    const t = await setup([22n, "adam", "ADMIN"], [23n, "mia", "MEMBER"], [24n, "adele", "ADMIN"]);
    expect((await hub.api(t.adam)("PATCH", "/admin/members/23", { role: "ADMIN" })).status).toBe(403);
    expect((await hub.api(t.adam)("PATCH", "/admin/members/24", { role: "MEMBER" })).status).toBe(403);
    expect((await hub.api(t.adam)("PATCH", "/admin/members/23", { role: "READER" })).status).toBe(200);
    expect(roleOf(23n)).toBe("READER");
    expect((await hub.api(t.olive)("PATCH", "/admin/members/23", { role: "ADMIN" })).status).toBe(200);
    expect((await hub.api(t.olive)("PATCH", "/admin/members/24", { role: "MEMBER" })).status).toBe(200);
    expect(roleOf(24n)).toBe("MEMBER");
  });

  it("OWNER role cannot be changed away except by transfer; garbage id/role is 400", async () => {
    const t = await setup();
    expect((await hub.api(t.olive)("PATCH", "/admin/members/1", { role: "MEMBER" })).status).toBe(409);
    expect((await hub.api(t.olive)("PATCH", "/admin/members/zz", { role: "MEMBER" })).status).toBe(400);
    expect((await hub.api(t.olive)("PATCH", "/admin/members/1", { role: "KING" })).status).toBe(400);
  });
});
