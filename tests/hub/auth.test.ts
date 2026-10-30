import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestHub, type TestHub } from "./harness";

const DAY = 24 * 60 * 60 * 1000;
let hub: TestHub;
let clock: number;

beforeEach(async () => {
  clock = Date.UTC(2026, 9, 29);
  hub = await startTestHub({ now: () => clock });
});
afterEach(async () => {
  await hub.close();
});

type Started = { deviceCode: string; userCode: string; pollSecret: string };
async function start() {
  return (await hub.api()("POST", "/auth/device/start")).body as Started;
}
const pollOf = (s: Started) => hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: s.pollSecret });
/** Full sign-in for an already-added fake user; returns the poll result. */
async function signIn(id: bigint) {
  const s = await start();
  hub.github.authorize(s.userCode, id);
  return pollOf(s);
}

describe("device-flow sign-in", () => {
  it("requests exactly the read:user scope", async () => {
    await start();
    const req = hub.github.requests.find((r) => r.path === "/login/device/code")!;
    expect(req.body).toMatchObject({ client_id: "test-client", scope: "read:user" });
  });

  it("start returns the device-flow fields", async () => {
    const r = await hub.api()("POST", "/auth/device/start");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ interval: 5, expiresIn: 900 });
    expect(r.body.deviceCode).toBeTruthy();
    expect(r.body.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body.userCode).toMatch(/-/);
    expect(r.body.verificationUri).toContain("/login/device");
  });

  it("first sign-in bootstraps the owner and names the team", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const start = (await hub.api()("POST", "/auth/device/start")).body as Started;
    expect((await pollOf(start)).status).toBe(202);
    hub.github.authorize(start.userCode, 101n);
    const r = await pollOf(start);
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ githubId: "101", login: "olive", role: "OWNER", status: "ACTIVE" });
    expect(r.body.team.name).toBe("olive's team");
    const health = (await hub.api()("GET", "/health")).body;
    expect(health.team).toEqual({ name: "olive's team" });
    expect(health.bootstrapped).toBe(true);
  });

  it("only the configured owner login can bootstrap an empty hub; the match ignores case", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 303n, login: "mallory" });
    expect((await hub.api()("GET", "/health")).body.bootstrapped).toBe(false);
    const refused = await signIn(303n);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ reason: "not-invited" });
    expect((await hub.api()("GET", "/health")).body.bootstrapped).toBe(false);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM member").get()).toEqual({ n: 0 });
    hub.github.addUser({ id: 101n, login: "OLIVE" });
    const r = await signIn(101n);
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ githubId: "101", login: "OLIVE", role: "OWNER" });
    expect((await hub.api()("GET", "/health")).body.bootstrapped).toBe(true);
    // Bootstrapped: the owner login is no longer special, mallory still needs an invite.
    expect((await signIn(303n)).body).toEqual({ reason: "not-invited" });
  });

  it("a second person is refused until invited, then admitted with the invite's role", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice", name: "Alice A" });
    expect((await signIn(101n)).status).toBe(200);
    const refused = await signIn(202n);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ reason: "not-invited" });

    const tokenOwner = (await signIn(101n)).body.session as string;
    const inv = await hub.api(tokenOwner)("POST", "/admin/invites", { githubLogin: "Alice", role: "MEMBER" });
    expect(inv.status).toBe(201);
    const ok = await signIn(202n);
    expect(ok.status).toBe(200);
    expect(ok.body.member).toMatchObject({ githubId: "202", login: "alice", name: "Alice A", role: "MEMBER", status: "ACTIVE" });
    expect(hub.db.prepare("SELECT used_at FROM invite WHERE id = ?").get(inv.body.invite.id)).toEqual({ used_at: new Date(clock).toISOString() });
  });

  it("an invite is bound to the numeric id: a renamed account cannot claim it, the invited id is admitted under a new login", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    hub.github.addUser({ id: 303n, login: "mallory" });
    const owner = (await signIn(101n)).body.session as string;
    const inv = await hub.api(owner)("POST", "/admin/invites", { githubLogin: "ALICE", role: "MEMBER" });
    expect(inv.status).toBe(201);
    expect(inv.body.invite).toMatchObject({ githubLogin: "alice", githubId: "202" });
    expect(hub.db.prepare("SELECT github_id FROM invite WHERE id = ?").safeIntegers(true).get(inv.body.invite.id)).toEqual({ github_id: 202n });
    const lookup = hub.github.requests.find((r) => r.path === "/users/ALICE");
    expect(lookup?.method).toBe("GET");
    // alice gives up her login; mallory takes it and tries the invite.
    hub.github.addUser({ id: 202n, login: "alice-renamed" });
    hub.github.addUser({ id: 303n, login: "alice" });
    const stolen = await signIn(303n);
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ reason: "not-invited" });
    const ok = await signIn(202n);
    expect(ok.status).toBe(200);
    expect(ok.body.member).toMatchObject({ githubId: "202", login: "alice-renamed", role: "MEMBER" });
  });

  it("a legacy invite without github_id still matches by login", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    await signIn(101n);
    hub.db
      .prepare("INSERT INTO invite (id, github_login, role, created_by, created_at, expires_at) VALUES ('legacy', 'Alice', 'READER', 101, ?, ?)")
      .run(new Date(clock).toISOString(), new Date(clock + DAY).toISOString());
    const r = await signIn(202n);
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ githubId: "202", role: "READER" });
  });

  it("inviting an unknown login is 404; an unreachable GitHub is 502", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const owner = (await signIn(101n)).body.session as string;
    const missing = await hub.api(owner)("POST", "/admin/invites", { githubLogin: "nobody", role: "MEMBER" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "GitHub user not found" });
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM invite").get()).toEqual({ n: 0 });
    await hub.github.close();
    expect((await hub.api(owner)("POST", "/admin/invites", { githubLogin: "alice", role: "MEMBER" })).status).toBe(502);
  });

  it("an expired invite does not admit", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    await signIn(101n);
    hub.db
      .prepare("INSERT INTO invite (id, github_login, role, created_by, created_at, expires_at) VALUES ('old', 'alice', 'MEMBER', 101, ?, ?)")
      .run(new Date(clock - 8 * DAY).toISOString(), new Date(clock - DAY).toISOString());
    expect((await signIn(202n)).body).toEqual({ reason: "not-invited" });
  });

  it("an active member's profile refreshes on sign-in", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    await signIn(101n);
    hub.github.addUser({ id: 101n, login: "olive2", name: "Olive", avatarUrl: "http://a/x.png" });
    const r = await signIn(101n);
    expect(r.body.member).toMatchObject({ login: "olive2", name: "Olive", avatarUrl: "http://a/x.png", role: "OWNER" });
  });

  it("a removed member gets 403 removed on sign-in", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    await signIn(101n);
    hub.db.prepare("INSERT INTO member (github_id, login, role, status) VALUES (202, 'alice', 'MEMBER', 'REMOVED')").run();
    const r = await signIn(202n);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ reason: "removed" });
  });

  it("a removed member's old session dies via DELETE /admin/members/:id; new device flow is 403 removed", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    hub.github.addUser({ id: 202n, login: "alice" });
    const owner = (await signIn(101n)).body.session as string;
    expect((await hub.api(owner)("POST", "/admin/invites", { githubLogin: "alice", role: "MEMBER" })).status).toBe(201);
    const old = (await signIn(202n)).body.session as string;
    expect((await hub.api(old)("GET", "/me")).status).toBe(200);
    expect((await hub.api(owner)("DELETE", "/admin/members/202")).status).toBe(204);
    expect((await hub.api(old)("GET", "/me")).status).toBe(401);
    const again = await signIn(202n);
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ reason: "removed" });
  });

  it("a session of a removed member gets 403 removed", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    hub.db.prepare("UPDATE member SET status = 'REMOVED' WHERE github_id = 101").run();
    const r = await hub.api(token)("GET", "/me");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "removed" });
  });

  it("denied and expired device codes", async () => {
    const d = await start();
    hub.github.deny(d.userCode);
    const denied = await pollOf(d);
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ reason: "denied" });

    const e = await start();
    hub.github.expire(e.userCode);
    const expired = await pollOf(e);
    expect(expired.status).toBe(410);
    expect(expired.body).toEqual({ error: "expired" });
  });

  it.each([9007199254740993n, 9223372036854775807n])("GitHub id %s keeps full precision through sign-in, /me and logout", async (id) => {
    hub.github.addUser({ id, login: "olive" });
    const r = await signIn(id);
    expect(r.status).toBe(200);
    expect(r.body.member.githubId).toBe(id.toString());
    const token = r.body.session as string;
    const me = await hub.api(token)("GET", "/me");
    expect(me.status).toBe(200);
    expect(me.body.member.githubId).toBe(id.toString());
    expect(me.body.members[0].githubId).toBe(id.toString());
    expect((await signIn(id)).body.member.githubId).toBe(id.toString());
    expect((await hub.api(token)("POST", "/auth/logout")).status).toBe(204);
    expect((await hub.api(token)("GET", "/me")).status).toBe(401);
  });

  it("poll rejects a missing deviceCode or pollSecret with 400", async () => {
    const s = await start();
    expect((await hub.api()("POST", "/auth/device/poll", {})).status).toBe(400);
    expect((await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode })).status).toBe(400);
    expect((await hub.api()("POST", "/auth/device/poll", { pollSecret: s.pollSecret })).status).toBe(400);
  });

  it("the device code alone never collects a session: wrong secret, unknown code and an expired flow are 404", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const s = await start();
    hub.github.authorize(s.userCode, 101n);
    const wrong = await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: "x".repeat(43) });
    expect(wrong.status).toBe(404);
    expect(JSON.stringify(wrong.body)).not.toContain("session");
    expect((await hub.api()("POST", "/auth/device/poll", { deviceCode: "nope", pollSecret: s.pollSecret })).status).toBe(404);
    expect(hub.github.requests.filter((r) => r.path === "/login/oauth/access_token")).toHaveLength(0);
    expect((await pollOf(s)).status).toBe(200);
    clock += 61_000; // past the grace period for a retried final poll
    expect((await pollOf(s)).status).toBe(404); // a finished flow is forgotten
    const late = await start();
    clock += 901_000; // past expiresIn
    expect((await pollOf(late)).status).toBe(404);
  });

  it("a final poll whose reply was lost can be asked again and returns the same session, for a minute", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const s = await start();
    hub.github.authorize(s.userCode, 101n);
    const first = await pollOf(s);
    expect(first.status).toBe(200);
    clock += 30_000;
    const again = await pollOf(s);
    expect(again.status).toBe(200);
    expect(again.body.session).toBe(first.body.session);
    expect(hub.github.requests.filter((r) => r.path === "/login/oauth/access_token")).toHaveLength(1); // answered from the stored result, not GitHub
    clock += 31_000;
    expect((await pollOf(s)).status).toBe(404);
  });

  it("a wrong poll secret still gets nothing during the grace period", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const s = await start();
    hub.github.authorize(s.userCode, 101n);
    expect((await pollOf(s)).status).toBe(200);
    const wrong = await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: "x".repeat(43) });
    expect(wrong.status).toBe(404);
    expect(JSON.stringify(wrong.body)).not.toContain("session");
  });

  it("GitHub's slow_down is passed on as 202 slowDown", async () => {
    const s = await start();
    hub.github.slowDown(s.userCode);
    const r = await pollOf(s);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ pending: true, slowDown: true });
    expect((await pollOf(s)).status).toBe(202); // the flow is still alive
  });

  it("31st poll per IP per minute is 429", async () => {
    const s = await start();
    for (let i = 0; i < 30; i++) expect((await pollOf(s)).status).toBe(202);
    const r = await pollOf(s);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    clock += 60_001;
    expect((await pollOf(s)).status).toBe(202);
  });
});

describe("sessions", () => {
  it("stores only the SHA-256 of a 32-byte base64url token", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = hub.db.prepare("SELECT id_hash FROM session").all() as { id_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].id_hash).not.toBe(token);
  });

  it("sessions slide 30 days and expire unused", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    clock += 29 * DAY;
    expect((await hub.api(token)("GET", "/me")).status).toBe(200);
    clock += 29 * DAY; // 58 days since sign-in, 29 since last use: slid
    expect((await hub.api(token)("GET", "/me")).status).toBe(200);
    clock += 31 * DAY;
    expect((await hub.api(token)("GET", "/me")).status).toBe(401);
  });

  it("GET /me returns member, team, members, spaces", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const token = (await signIn(101n)).body.session as string;
    const r = await hub.api(token)("GET", "/me");
    expect(r.status).toBe(200);
    expect(r.body.member.login).toBe("olive");
    expect(r.body.team.name).toBe("olive's team");
    expect(r.body.members).toHaveLength(1);
    expect(r.body.spaces).toEqual([{ id: "common", kind: "COMMON", name: "Workspace", canWrite: true, seq: "0" }]);
  });

  it("logout kills only that session", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    const a = (await signIn(101n)).body.session as string;
    const b = (await signIn(101n)).body.session as string;
    expect((await hub.api(a)("POST", "/auth/logout")).status).toBe(204);
    expect((await hub.api(a)("GET", "/me")).status).toBe(401);
    expect((await hub.api(b)("GET", "/me")).status).toBe(200);
  });

  it("malformed Authorization is 401, not 500", async () => {
    for (const h of ["Bearer", "Bearer ", "Basic abc", "Token x", "Bearer a b", "Bearer é", "bearer", "Bearer nope"]) {
      const r = await fetch(hub.url + "/me", { headers: { authorization: h } });
      expect(r.status, h).toBe(401);
    }
    expect((await fetch(hub.url + "/me")).status).toBe(401);
  });
});

describe("GitHub token hygiene", () => {
  it("the GitHub access token is never stored or logged", async () => {
    hub.github.addUser({ id: 101n, login: "olive" });
    expect((await signIn(101n)).status).toBe(200);
    const tokens = [...hub.github.tokens.keys()];
    expect(tokens.length).toBeGreaterThan(0);

    const tables = (hub.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of tables) {
      const dump = JSON.stringify(hub.db.prepare(`SELECT * FROM "${t}"`).all());
      for (const tok of tokens) expect(dump, `table ${t}`).not.toContain(tok);
    }
    expect(hub.logs.length).toBeGreaterThan(0);
    for (const line of hub.logs) for (const tok of tokens) expect(line).not.toContain(tok);
  });
});

describe("request log", () => {
  it("has method path status ms and member, never token, query or user code", async () => {
    hub.github.addUser({ id: 7n, login: "olive" });
    const s = await start();
    hub.github.authorize(s.userCode, 7n);
    const r = await pollOf(s);
    const token = r.body.session as string;
    await hub.api(token)("GET", "/me?secretq=sneaky");
    const ghToken = [...hub.github.tokens.keys()][0];
    const all = hub.logs.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain(ghToken);
    expect(all).not.toContain(s.userCode);
    expect(all).not.toContain(s.deviceCode);
    expect(all).not.toContain(s.pollSecret);
    expect(all).not.toContain("sneaky");
    const line = hub.logs.map((l) => JSON.parse(l)).find((l) => l.msg === "request" && l.path === "/me");
    expect(line).toMatchObject({ method: "GET", path: "/me", status: 200, member: "7" });
    expect(typeof line.ms).toBe("number");
  });
});
