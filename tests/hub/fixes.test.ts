import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { signInAs, startTestHub, type TestHub } from "./harness";

let hub: TestHub;
beforeEach(async () => {
  hub = await startTestHub();
});
afterEach(async () => {
  await hub.close();
});

function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(text));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("close", () => resolve(out));
    s.on("error", () => resolve(out));
    setTimeout(() => s.destroy(), 1500);
  });
}
const portOf = () => Number(new URL(hub.url).port);

describe("malformed request targets", () => {
  it("upgrade with an invalid url is answered 400 and the hub stays up", async () => {
    const out = await raw(portOf(), "GET // HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
    expect(out).toContain("400");
    expect((await hub.api()("GET", "/health")).status).toBe(200);
  });
  it("plain http with an invalid url is 400 bad path", async () => {
    const out = await raw(portOf(), "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(out).toContain("400");
    expect(out).toContain("bad path");
  });
});

/** Starts a PATCH, sends headers and part of the body, and returns a function that finishes it. */
async function slowPatch(token: string, id: string): Promise<{ finish: (rest: string) => Promise<number> }> {
  const req = http.request(hub.url + `/admin/members/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "transfer-encoding": "chunked" } });
  const done = new Promise<number>((r) => req.on("response", (res) => (res.resume(), r(res.statusCode ?? 0))));
  req.write("{");
  await new Promise((r) => setTimeout(r, 100)); // let the hub authenticate the request first
  return { finish: (rest) => (req.end(rest), done) };
}

async function team() {
  const olive = await signInAs(hub, 1n, "olive");
  const inv = async (id: bigint, login: string, role: string) => {
    hub.github.addUser({ id, login });
    expect((await hub.api(olive)("POST", "/admin/invites", { githubLogin: login, role })).status).toBe(201);
    return signInAs(hub, id, login);
  };
  return { olive, adam: await inv(2n, "adam", "ADMIN"), mia: await inv(3n, "mia", "MEMBER"), max: await inv(4n, "max", "MEMBER") };
}
const owners = () => (hub.db.prepare("SELECT COUNT(*) AS n FROM member WHERE role = 'OWNER'").get() as { n: number }).n;

describe("admin actor is re-read after the body", () => {
  it("a stale owner cannot transfer ownership a second time", async () => {
    const t = await team();
    const slow = await slowPatch(t.olive, "3");
    expect((await hub.api(t.olive)("PATCH", "/admin/members/2", { role: "OWNER" })).status).toBe(200);
    expect(await slow.finish('"role":"OWNER"}')).toBe(403);
    expect(owners()).toBe(1);
  });
  it("a removed admin cannot finish an in-flight action", async () => {
    const t = await team();
    const slow = await slowPatch(t.adam, "3");
    expect((await hub.api(t.olive)("DELETE", "/admin/members/2")).status).toBe(204);
    expect(await slow.finish('"role":"READER"}')).toBe(403);
    expect((hub.db.prepare("SELECT role FROM member WHERE github_id = 3").get() as { role: string }).role).toBe("MEMBER");
  });
});

describe("invites", () => {
  it("inviting a removed login is 409", async () => {
    const t = await team();
    expect((await hub.api(t.olive)("DELETE", "/admin/members/3")).status).toBe(204);
    const r = await hub.api(t.olive)("POST", "/admin/invites", { githubLogin: "mia", role: "MEMBER" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "member was removed; the owner can reinstate them" });
  });
});

describe("reinstating a removed member", () => {
  it("only the owner can; the person signs in again as the chosen role, in the common space only", async () => {
    const t = await team();
    const restricted = (await hub.api(t.olive)("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "3", canWrite: true }] })).body.space.id as string;
    expect((await hub.api(t.mia)("GET", `/spaces/${restricted}/snapshot`)).status).toBe(200);
    expect((await hub.api(t.adam)("DELETE", "/admin/members/3")).status).toBe(204); // an admin removed a member
    expect((await hub.api(t.mia)("GET", "/me")).status).toBe(401); // sessions revoked
    expect((await hub.api(t.olive)("GET", "/admin/members")).body.members.find((m: { githubId: string }) => m.githubId === "3").status).toBe("REMOVED");

    // not the removing admin, not the person, not a plain member
    for (const who of [t.adam, t.max]) expect((await hub.api(who)("POST", "/admin/members/3/reinstate", { role: "MEMBER" })).status).toBe(403);
    expect((await hub.api(t.olive)("POST", "/admin/members/4/reinstate", {})).status).toBe(409); // not removed
    expect((await hub.api(t.olive)("POST", "/admin/members/3/reinstate", { role: "OWNER" })).status).toBe(400);

    const r = await hub.api(t.olive)("POST", "/admin/members/3/reinstate", { role: "READER" });
    expect(r.status).toBe(200);
    expect(r.body.member).toMatchObject({ githubId: "3", status: "ACTIVE", role: "READER" });

    // the old session stays dead; signing in again works, with the chosen role and without the restricted space
    expect((await hub.api(t.mia)("GET", "/me")).status).toBe(401);
    const again = await signInAs(hub, 3n, "mia");
    const me = (await hub.api(again)("GET", "/me")).body;
    expect(me.member).toMatchObject({ role: "READER", status: "ACTIVE" });
    expect(me.spaces.map((s: { kind: string }) => s.kind)).toEqual(["COMMON"]);
    expect((await hub.api(again)("GET", `/spaces/${restricted}/snapshot`)).status).toBe(404);
    expect((await hub.api(t.olive)("POST", "/admin/members/3/reinstate", {})).status).toBe(409); // already active
  });

  it("defaults to MEMBER, and an invite for a removed person points at it", async () => {
    const t = await team();
    expect((await hub.api(t.olive)("DELETE", "/admin/members/3")).status).toBe(204);
    expect((await hub.api(t.olive)("POST", "/admin/members/3/reinstate", {})).body.member.role).toBe("MEMBER");
  });
});
