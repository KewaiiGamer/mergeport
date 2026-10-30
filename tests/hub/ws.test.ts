import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { WS_SILENCE_MS } from "../../hub/src/notify";
import { signInAs, startTestHub, type TestHub } from "./harness";

type Msg = { t: string; [k: string]: unknown };

class Client {
  readonly ws: WebSocket;
  readonly msgs: Msg[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;
  readonly opened: Promise<boolean>;
  constructor(url: string, protocols: string[]) {
    this.ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", protocols);
    this.ws.addEventListener("message", (e) => this.msgs.push(JSON.parse(String(e.data)) as Msg));
    this.opened = new Promise((r) => {
      this.ws.addEventListener("open", () => r(true));
      this.ws.addEventListener("error", () => r(false));
    });
    this.closed = new Promise((r) =>
      this.ws.addEventListener("close", (e) => {
        this.closeCode = e.code;
        r(e.code);
      }),
    );
  }
  ofType(t: string): Msg[] {
    return this.msgs.filter((m) => m.t === t);
  }
  async waitFor(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timeout waiting for message; got ${JSON.stringify(this.msgs)}`);
      await sleep(10);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms = 3000): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

let hub: TestHub;
let owner: string;
let api: ReturnType<TestHub["api"]>;
const clients: Client[] = [];
let clock = Date.now();

async function start(o: Parameters<typeof startTestHub>[0] = {}) {
  hub = await startTestHub({ now: () => clock, ...o });
  owner = await signInAs(hub, 1n, "olive");
  api = hub.api(owner);
}
async function connect(token: string): Promise<Client> {
  const c = new Client(hub.url, ["mergeport.v1", "bearer." + token]);
  clients.push(c);
  expect(await c.opened).toBe(true);
  await c.waitFor((m) => m.t === "hello");
  return c;
}
async function addMember(id: bigint, login: string, role = "MEMBER"): Promise<string> {
  hub.github.addUser({ id, login });
  expect((await api("POST", "/admin/invites", { githubLogin: login, role })).status).toBe(201);
  return signInAs(hub, id, login);
}
const up = (opId: string, entityId: string, baseVersion = 0) => ({ opId, type: "task", entityId, kind: "UPSERT", baseVersion, data: { title: opId } });

beforeEach(() => {
  clock = Date.now();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await hub.close();
});

describe("GET /ws", () => {
  it("sends hello with spaces and seq", async () => {
    await start();
    await api("POST", "/spaces/common/ops", { ops: [up("a", "t1"), up("b", "t2")] });
    const c = await connect(owner);
    expect(c.ws.protocol).toBe("mergeport.v1");
    expect(c.msgs[0]).toEqual({ t: "hello", spaces: [{ id: "common", seq: "2" }] });
  });

  it("one changed per space for a burst of ops within 100 ms", async () => {
    await start();
    const c = await connect(owner);
    await Promise.all([1, 2, 3, 4, 5].map((i) => api("POST", "/spaces/common/ops", { ops: [up(`op${i}`, `t${i}`)] })));
    await c.waitFor((m) => m.t === "changed");
    await sleep(300);
    expect(c.ofType("changed")).toEqual([{ t: "changed", spaceId: "common", seq: "5" }]);
  });

  it("a non-member of a restricted space gets no changed for it", async () => {
    await start();
    const bob = await addMember(2n, "bob");
    const carol = await addMember(3n, "carol");
    const sp = await api("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "2", canWrite: true }] });
    const id = sp.body.space.id as string;
    const cb = await connect(bob);
    const cc = await connect(carol);
    expect(cc.msgs[0]).toEqual({ t: "hello", spaces: [{ id: "common", seq: "0" }] });
    expect(cb.msgs[0]).toEqual({ t: "hello", spaces: [{ id: "common", seq: "0" }, { id, seq: "0" }] });
    expect((await hub.api(bob)("POST", `/spaces/${id}/ops`, { ops: [up("s1", "x")] })).status).toBe(200);
    expect(await cb.waitFor((m) => m.t === "changed")).toEqual({ t: "changed", spaceId: id, seq: "1" });
    await sleep(300);
    expect(cc.ofType("changed")).toEqual([]);
  });

  it("removing a member closes with 4403 and an in-flight push is 403", async () => {
    await start();
    const bob = await addMember(2n, "bob");
    const cb = await connect(bob);
    clock += 1000; // any authenticated request now moves last_seen_at, so the test can see the server pass auth
    const seen = () => (hub.db.prepare("SELECT last_seen_at FROM session WHERE github_id = 2").get() as { last_seen_at: string }).last_seen_at;
    const before = seen();
    const body = JSON.stringify({ ops: [up("late", "t-late")] });
    // Headers go out and the hub authorizes; the body is held back until the member is removed.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(hub.url + "/spaces/common/ops", {
        method: "POST",
        headers: { authorization: `Bearer ${bob}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      req.on("response", (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.flushHeaders();
      void (async () => {
        while (seen() === before) await sleep(5); // the hub passed requireSession and spaceAccess, and is now awaiting the body
        expect((await api("DELETE", "/admin/members/2")).status).toBe(204);
        req.end(body);
      })().catch(reject);
    });
    expect(status).toBe(403);
    expect(await withTimeout(cb.closed)).toBe(4403);
    expect(cb.ofType("bye")).toEqual([{ t: "bye", reason: "removed" }]);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM entity_event WHERE actor_github_id = 2").get()).toEqual({ n: 0 });
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM entity").get()).toEqual({ n: 0 });
    expect(cb.ofType("changed")).toEqual([]);
  });

  it("an in-flight push from a member demoted to READER is 403 and writes nothing", async () => {
    await start();
    const bob = await addMember(2n, "bob");
    clock += 1000;
    const seen = () => (hub.db.prepare("SELECT last_seen_at FROM session WHERE github_id = 2").get() as { last_seen_at: string }).last_seen_at;
    const before = seen();
    const body = JSON.stringify({ ops: [up("late", "t-late")] });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(hub.url + "/spaces/common/ops", {
        method: "POST",
        headers: { authorization: `Bearer ${bob}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      });
      req.on("response", (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.flushHeaders();
      void (async () => {
        while (seen() === before) await sleep(5);
        expect((await api("PATCH", "/admin/members/2", { role: "READER" })).status).toBe(200);
        req.end(body);
      })().catch(reject);
    });
    expect(status).toBe(403);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM entity_event").get()).toEqual({ n: 0 });
  });

  it("a removed member whose session survived is told bye removed and closed 4403, not refused with HTTP 403", async () => {
    await start();
    const alice = await addMember(2n, "alice");
    hub.db.prepare("UPDATE member SET status = 'REMOVED' WHERE github_id = 2").run();
    const c = new Client(hub.url, ["mergeport.v1", "bearer." + alice]);
    clients.push(c);
    expect(await c.opened).toBe(true);
    expect(await withTimeout(c.closed)).toBe(4403);
    expect(c.msgs).toEqual([{ t: "bye", reason: "removed" }]); // no hello, no spaces
    // The hub keeps nothing for it: a change fans out to nobody.
    expect((await api("POST", "/spaces/common/ops", { ops: [up("o1", "t1")] })).status).toBe(200);
    await sleep(150);
    expect(c.msgs).toHaveLength(1);
  });

  it("invalid token is refused before upgrade", async () => {
    await start();
    const attempt = (protocols?: string) =>
      new Promise<number>((resolve, reject) => {
        const headers: Record<string, string> = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
        if (protocols) headers["sec-websocket-protocol"] = protocols;
        const req = http.request(hub.url + "/ws", { headers });
        req.on("response", (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on("upgrade", (_r, s) => {
          s.destroy();
          reject(new Error("upgraded"));
        });
        req.on("error", reject);
        req.end();
      });
    expect(await attempt("mergeport.v1, bearer.not-a-real-token")).toBe(401);
    expect(await attempt("mergeport.v1")).toBe(401);
    expect(await attempt()).toBe(401);
    expect(await attempt(`bearer.${owner}`)).toBe(401); // no mergeport.v1 offered
    const c = new Client(hub.url, ["mergeport.v1", "bearer.bogus"]);
    expect(await c.opened).toBe(false);
    // and the real token still upgrades
    expect(await attempt(`mergeport.v1, bearer.${owner}`).catch((e: Error) => e.message)).toBe("upgraded");
  });

  it("silent socket is dropped after the silence window, pinging one stays", async () => {
    expect(WS_SILENCE_MS).toBe(75_000);
    await start({ ws: { silenceMs: 400 } });
    const silent = await connect(owner);
    const chatty = await connect(owner);
    const pinger = setInterval(() => chatty.ws.send(JSON.stringify({ t: "ping" })), 100);
    try {
      expect(await withTimeout(silent.closed, 2500)).toBe(1006);
      await sleep(600);
      expect(chatty.closeCode).toBeNull();
      expect(chatty.ofType("pong").length).toBeGreaterThan(3);
      expect(chatty.ofType("pong")[0]).toEqual({ t: "pong" });
    } finally {
      clearInterval(pinger);
    }
  });

  it("access added/removed/deleted and team member/role fan out", async () => {
    await start();
    const bob = await addMember(2n, "bob");
    const carol = await addMember(3n, "carol");
    const cb = await connect(bob);
    const cc = await connect(carol);
    const co = await connect(owner);

    const sp = await api("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "2", canWrite: true }] });
    const id = sp.body.space.id as string;
    await cb.waitFor((m) => m.t === "access" && m.action === "added");
    expect(cb.ofType("access")).toEqual([{ t: "access", spaceId: id, action: "added" }]);
    expect(cc.ofType("access")).toEqual([]);

    await api("PATCH", `/admin/spaces/${id}`, { members: [{ githubId: "3", canWrite: false }] });
    await cc.waitFor((m) => m.t === "access" && m.action === "added");
    await cb.waitFor((m) => m.t === "access" && m.action === "removed");
    expect(cb.ofType("access")[1]).toEqual({ t: "access", spaceId: id, action: "removed" });
    expect(cc.ofType("access")).toEqual([{ t: "access", spaceId: id, action: "added" }]);

    await api("PATCH", `/admin/spaces/${id}`, { members: [{ githubId: "2", canWrite: true }, { githubId: "3", canWrite: false }] });
    await cb.waitFor((m) => m.t === "access" && m.action === "added" && cb.ofType("access").length === 3);
    await api("DELETE", `/admin/spaces/${id}`);
    await cb.waitFor((m) => m.t === "access" && m.action === "deleted");
    await cc.waitFor((m) => m.t === "access" && m.action === "deleted");
    expect(cc.ofType("access").at(-1)).toEqual({ t: "access", spaceId: id, action: "deleted" });
    expect(co.ofType("access").filter((m) => m.action === "deleted")).toEqual([]); // the owner is no member of it

    expect((await api("PATCH", "/admin/members/2", { role: "READER" })).status).toBe(200);
    for (const c of [cb, cc, co]) await c.waitFor((m) => m.t === "team" && m.reason === "role");
    expect(co.ofType("team")).toEqual([{ t: "team", reason: "role" }]);

    expect((await api("DELETE", "/admin/members/3")).status).toBe(204);
    await cb.waitFor((m) => m.t === "team" && m.reason === "member");
    await co.waitFor((m) => m.t === "team" && m.reason === "member");
    expect(await withTimeout(cc.closed)).toBe(4403);
    expect(cc.ofType("team").filter((m) => m.reason === "member")).toEqual([]); // the removed one gets bye, not team
  });

  it("closing the hub says bye shutdown and closes 1001", async () => {
    await start();
    const c = await connect(owner);
    await hub.close();
    expect(await withTimeout(c.closed)).toBe(1001);
    expect(c.ofType("bye")).toEqual([{ t: "bye", reason: "shutdown" }]);
  });

  it("logout and expiry do not leave the socket open", async () => {
    await start();
    const bob = await addMember(2n, "bob");
    const cb = await connect(bob);
    expect((await hub.api(bob)("POST", "/auth/logout")).status).toBe(204);
    expect(await withTimeout(cb.closed)).toBe(4401);

    const carol = await addMember(3n, "carol");
    const cc = await connect(carol);
    clock += 31 * 24 * 60 * 60 * 1000;
    cc.ws.send(JSON.stringify({ t: "ping" }));
    expect(await withTimeout(cc.closed)).toBe(4401);
    expect(cc.ofType("pong")).toEqual([]);
  });

  it("a ping slides the session expiry", async () => {
    await start();
    const c = await connect(owner);
    const exp = () => (hub.db.prepare("SELECT expires_at FROM session WHERE github_id = 1").get() as { expires_at: string }).expires_at;
    const before = exp();
    clock += 60_000;
    c.ws.send(JSON.stringify({ t: "ping" }));
    await c.waitFor((m) => m.t === "pong");
    expect(exp() > before).toBe(true);
  });
});

describe("team event on invite acceptance", () => {
  it("accepting an invite pushes team/member to connected sockets", async () => {
    const hub = await startTestHub();
    try {
      const olive = await signInAs(hub, 1n, "olive");
      const c = new Client(hub.url, ["mergeport.v1", `bearer.${olive}`]);
      await c.opened;
      hub.github.addUser({ id: 2n, login: "mia" });
      await hub.api(olive)("POST", "/admin/invites", { githubLogin: "mia", role: "MEMBER" });
      await signInAs(hub, 2n, "mia");
      await c.waitFor((m) => m.t === "team" && m.reason === "member");
      c.ws.close();
    } finally {
      await hub.close();
    }
  });
});
