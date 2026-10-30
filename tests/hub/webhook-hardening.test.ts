import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { SHARED_REPO_SQL } from "../../hub/src/notify";
import { deliver, ghRepo, signInAs, startTestHub, type TestHub } from "./harness";

const SECRET = "h".repeat(24) + "0123456789abcdef";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let hub: TestHub;
let api: ReturnType<TestHub["api"]>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  hub = await startTestHub();
  api = hub.api(await signInAs(hub, 1n, "olive"));
  expect((await api("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(204);
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await hub.close();
});

function connect(token: string): { ws: WebSocket; msgs: any[]; closed: Promise<number>; ready: Promise<void> } {
  const ws = new WebSocket(hub.url.replace(/^http/, "ws") + "/ws", ["mergeport.v1", "bearer." + token]);
  sockets.push(ws);
  const msgs: any[] = [];
  ws.addEventListener("message", (e) => msgs.push(JSON.parse(String(e.data))));
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  const ready = new Promise<void>((r) => {
    const t = setInterval(() => {
      if (msgs.some((m) => m.t === "hello")) {
        clearInterval(t);
        r();
      }
    }, 5);
  });
  return { ws, msgs, closed, ready };
}
const withTimeout = <T>(p: Promise<T>, v: T) => Promise.race([p, sleep(3000).then(() => v)]);

describe("body reading", () => {
  it("stops reading past 1 MiB: 413 with connection close, then the socket is cut without taking the rest", async () => {
    let sent = 0;
    const status = await new Promise<{ status: number; connection: string | undefined }>((resolve) => {
      const req = http.request(hub.url + "/webhooks/github", { method: "POST", headers: { "x-github-event": "push", "x-hub-signature-256": "sha256=" + "0".repeat(64), "content-type": "application/json" } });
      let answered: { status: number; connection: string | undefined } | null = null;
      req.on("response", (r) => {
        answered = { status: r.statusCode ?? 0, connection: r.headers.connection };
        r.resume();
        r.on("close", () => resolve(answered!));
      });
      req.on("error", () => resolve(answered ?? { status: 0, connection: undefined }));
      const chunk = Buffer.alloc(64 * 1024, 120);
      void (async () => {
        // 300 MiB offered; a draining server would take all of it.
        while (sent < 300 * 1024 * 1024 && !answered && !req.destroyed) {
          sent += chunk.length;
          if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
        }
        if (!answered) req.end();
      })();
    });
    // A client still streaming may see the connection reset before it reads the answer; when it does read it, it is 413 + close.
    expect([0, 413]).toContain(status.status);
    if (status.status === 413) expect(status.connection).toBe("close");
    expect(sent).toBeLessThan(100 * 1024 * 1024);
  }, 30_000);

  it("a body that is only just over the limit is 413 and the hub keeps working", async () => {
    const body = "x".repeat(1024 * 1024 + 1);
    expect((await deliver(hub, SECRET, "push", body)).status).toBe(413);
    expect((await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }))).status).toBe(200);
  });

  it("refuses the 17th concurrent body with 503 busy before reading it; slots free up again", async () => {
    const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
    const stalled: http.ClientRequest[] = [];
    for (let i = 0; i < 16; i++) {
      const req = http.request(hub.url + "/webhooks/github", { method: "POST", agent, headers: { "x-github-event": "push", "content-type": "application/json", "content-length": "1000" } });
      req.on("error", () => undefined);
      req.flushHeaders();
      req.write("{");
      stalled.push(req);
    }
    await sleep(300);
    const busy = await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }));
    expect(busy.status).toBe(503);
    expect(busy.body).toEqual({ error: "busy" });
    expect(busy.headers.get("retry-after")).toBe("1");
    for (const r of stalled) r.destroy();
    await sleep(300);
    expect((await deliver(hub, SECRET, "push", JSON.stringify({ repository: ghRepo(1, "o") }))).status).toBe(200);
    agent.destroy();
  });
});

describe("redelivery after a failed relay", () => {
  it("a delivery whose relay threw is processed again, then deduped once it succeeded", async () => {
    const bob = await (async () => {
      hub.github.addUser({ id: 2n, login: "bob" });
      await api("POST", "/admin/invites", { githubLogin: "bob", role: "MEMBER" });
      return signInAs(hub, 2n, "bob");
    })();
    const c = connect(bob);
    await c.ready;
    c.ws.send(JSON.stringify({ t: "watch", repos: ["55"] }));
    c.ws.send(JSON.stringify({ t: "ping" }));
    while (!c.msgs.some((m) => m.t === "pong")) await sleep(5);

    const body = { action: "opened", repository: ghRepo(55, "someone", true, 999) };
    // Private and not bob's: the relay reads the entity table to see whether it is shared. Make that fail.
    hub.db.exec("ALTER TABLE entity RENAME TO entity_off");
    let first;
    try {
      first = await deliver(hub, SECRET, "issues", body, { delivery: "retry-me" });
    } finally {
      hub.db.exec("ALTER TABLE entity_off RENAME TO entity");
    }
    expect(first.status).toBe(500);
    expect((await api("GET", "/me")).body.webhooks.lastDeliveryAt).toBeNull();
    // Common space shares it with everyone.
    const op = { opId: "o1", type: "repo", entityId: "r55", kind: "UPSERT", baseVersion: 0, data: { githubId: 55 } };
    expect((await api("POST", "/spaces/common/ops", { ops: [op] })).status).toBe(200);
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "retry-me" })).body).toEqual({ ok: true, notified: 1 });
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "retry-me" })).body).toEqual({ ok: true, notified: 0 });
    await sleep(50);
    expect(c.msgs.filter((m) => m.t === "gh").map((m) => m.delivery)).toEqual(["retry-me"]);
  });
});

describe("shared-space lookup index", () => {
  it("the query uses entity_repo_github, not a table scan", () => {
    const plan = (hub.db.prepare("EXPLAIN QUERY PLAN " + SHARED_REPO_SQL).all(1n, "1") as { detail: string }[]).map((r) => r.detail).join("\n");
    expect(plan).toContain("entity_repo_github");
    expect(plan).not.toMatch(/SCAN entity\b/);
  });
});

describe("client frame limits", () => {
  it("a non-watch message over 4 KiB closes the socket; a 45 KB watch is fine", async () => {
    const tok = await signInAs(hub, 1n, "olive");
    const a = connect(tok);
    await a.ready;
    const ids = Array.from({ length: 2000 }, (_, i) => String(1000 + i));
    a.ws.send(JSON.stringify({ t: "watch", repos: ids }));
    a.ws.send(JSON.stringify({ t: "ping" }));
    while (!a.msgs.some((m) => m.t === "pong")) await sleep(5);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.send(JSON.stringify({ t: "ping", pad: "x".repeat(5000) }));
    expect(await withTimeout(a.closed, -1)).toBe(1009);
  });

  it("more than 30 frames in 10 s closes with 1008; a few pings do not", async () => {
    const tok = await signInAs(hub, 1n, "olive");
    const a = connect(tok);
    await a.ready;
    for (let i = 0; i < 30; i++) a.ws.send(JSON.stringify({ t: "ping" }));
    await sleep(200);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    expect(a.msgs.filter((m) => m.t === "pong")).toHaveLength(30);
    a.ws.send(JSON.stringify({ t: "ping" }));
    expect(await withTimeout(a.closed, -1)).toBe(1008);
  });
});
