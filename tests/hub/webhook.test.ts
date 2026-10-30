import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliver, ghRepo, signBody, signInAs, startTestHub, type TestHub } from "./harness";

const SECRET = "w".repeat(24) + "0123456789abcdef";
const TITLE = "TOP-SECRET-TITLE-9f3a1c";

type Msg = { t: string; [k: string]: unknown };

class Client {
  readonly ws: WebSocket;
  readonly msgs: Msg[] = [];
  closeCode: number | null = null;
  readonly opened: Promise<boolean>;
  readonly closed: Promise<number>;
  constructor(url: string, token: string) {
    this.ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", ["mergeport.v1", "bearer." + token]);
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
  gh(): Msg[] {
    return this.msgs.filter((m) => m.t === "gh");
  }
  async waitFor(pred: (m: Msg) => boolean, ms = 3000): Promise<Msg> {
    const end = Date.now() + ms;
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(this.msgs).slice(0, 500)}`);
      await sleep(10);
    }
  }
  /** Sends `watch`, then a ping; the pong proves the hub handled the watch (frames are handled in order). */
  async watch(ids: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    const before = this.msgs.filter((m) => m.t === "pong").length;
    this.ws.send(JSON.stringify({ t: "watch", repos: ids, ...extra }));
    this.ws.send(JSON.stringify({ t: "ping" }));
    const end = Date.now() + 3000;
    while (this.msgs.filter((m) => m.t === "pong").length === before) {
      if (Date.now() > end) throw new Error("no pong after watch");
      await sleep(5);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let hub: TestHub;
let api: ReturnType<TestHub["api"]>;
const clients: Client[] = [];

async function connect(token: string): Promise<Client> {
  const c = new Client(hub.url, token);
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
/** Shares a repository by id in a space, as the app does (entity type `repo`, data.githubId). */
async function shareRepo(token: string, spaceId: string, entityId: string, githubId: number | string, kind: "UPSERT" | "DELETE" = "UPSERT") {
  const op = { opId: `op-${entityId}-${kind}`, type: "repo", entityId, kind, baseVersion: kind === "UPSERT" ? 0 : 1, data: kind === "UPSERT" ? { githubId, fullName: "x/y" } : undefined };
  const r = await hub.api(token)("POST", `/spaces/${spaceId}/ops`, { ops: [op] });
  expect(r.status).toBe(200);
}
const issue = (repo: ReturnType<typeof ghRepo>, extra: Record<string, unknown> = {}) => ({ action: "opened", issue: { number: 1, title: TITLE }, repository: repo, ...extra });

beforeEach(async () => {
  hub = await startTestHub();
  const owner = await signInAs(hub, 1n, "olive");
  api = hub.api(owner);
  expect((await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "mergeport-t" })).status).toBe(204);
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.close();
  await hub.close();
});

describe("POST /webhooks/github: authentication and framing", () => {
  it("404 when no secret exists from either source", async () => {
    await api("DELETE", "/admin/github-webhook");
    const r = await deliver(hub, SECRET, "issues", issue(ghRepo(1, "o")));
    expect(r.status).toBe(404);
  });

  it("accepts a valid signature", async () => {
    const r = await deliver(hub, SECRET, "issues", issue(ghRepo(1, "o")));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, notified: 0 });
  });

  it("401 for a wrong, missing, truncated or malformed signature, and nothing else happens", async () => {
    const watcher = await connect(await signInAs(hub, 1n, "olive"));
    await watcher.watch(["7"]);
    const body = JSON.stringify(issue(ghRepo(7, "olive")));
    const good = signBody(SECRET, body);
    const bad = [
      signBody("z".repeat(40), body),
      null,
      good.slice(0, -2),
      good + "00",
      good.replace("sha256=", "sha1="),
      good.replace("sha256=", ""),
      "sha256=" + "g".repeat(64),
      "sha256=",
      signBody(SECRET, body + " "),
    ];
    for (const signature of bad) {
      const r = await deliver(hub, SECRET, "issues", body, { signature });
      expect(r.status).toBe(401);
    }
    await sleep(100);
    expect(watcher.gh()).toHaveLength(0);
    expect((await api("GET", "/me")).body.webhooks.lastDeliveryAt).toBeNull();
    // The same delivery id was never consumed by the rejected attempts.
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "same" })).status).toBe(200);
  });

  it("413 above 1 MiB, accepted at exactly 1 MiB", async () => {
    const filler = (n: number) => {
      const base = JSON.stringify({ repository: ghRepo(1, "o"), pad: "" });
      return JSON.stringify({ repository: ghRepo(1, "o"), pad: "x".repeat(n - base.length) });
    };
    const exact = filler(1024 * 1024);
    expect(Buffer.byteLength(exact)).toBe(1024 * 1024);
    expect((await deliver(hub, SECRET, "push", exact)).status).toBe(200);
    const over = filler(1024 * 1024 + 1);
    expect(Buffer.byteLength(over)).toBe(1024 * 1024 + 1);
    expect((await deliver(hub, SECRET, "push", over)).status).toBe(413);
  });

  it("invalid JSON with a valid signature is 400", async () => {
    expect((await deliver(hub, SECRET, "issues", "{not json")).status).toBe(400);
  });

  it("the signature covers the raw bytes, not a re-serialisation", async () => {
    const body = '{ "repository" : {"id":5,  "private":false,"owner":{"login":"o"}} }';
    expect((await deliver(hub, SECRET, "issues", body)).status).toBe(200);
  });
});

describe("POST /webhooks/github: events", () => {
  it("ping, installation and installation_repositories are recorded, not relayed", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["9"]);
    for (const event of ["ping", "installation", "installation_repositories"]) {
      const r = await deliver(hub, SECRET, event, { zen: "x", repository: ghRepo(9, "olive") });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect((await api("GET", "/me")).body.webhooks.lastEvent).toBe(event);
    }
    // They need no repository object at all.
    expect((await deliver(hub, SECRET, "installation", { action: "created" })).status).toBe(200);
    await sleep(100);
    expect(c.gh()).toHaveLength(0);
  });

  it("an event outside the relayed list is 202 and ignored", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["9"]);
    for (const event of ["fork", "star", "release", "workflow_run", "", "ISSUES"]) {
      const r = await deliver(hub, SECRET, event, { repository: ghRepo(9, "olive") });
      expect(r.status).toBe(202);
    }
    await sleep(100);
    expect(c.gh()).toHaveLength(0);
    expect((await api("GET", "/me")).body.webhooks.lastEvent).toBeNull();
  });

  it("every relayed event name is relayed", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["9"]);
    const events = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_run", "check_suite", "status", "push", "create", "delete"];
    for (const e of events) expect((await deliver(hub, SECRET, e, { repository: ghRepo(9, "olive") })).body).toEqual({ ok: true, notified: 1 });
    await sleep(100);
    expect(c.gh().map((m) => m.event)).toEqual(events);
  });

  it("400 when repository id, private or owner.login is missing or mistyped", async () => {
    const repo = ghRepo(1, "o");
    const cases: unknown[] = [
      {},
      { repository: null },
      { repository: "x" },
      { repository: { ...repo, id: undefined } },
      { repository: { ...repo, id: "1" } },
      { repository: { ...repo, id: 1.5 } },
      { repository: { ...repo, private: undefined } },
      { repository: { ...repo, private: "false" } },
      { repository: { ...repo, owner: undefined } },
      { repository: { ...repo, owner: {} } },
      { repository: { ...repo, owner: { login: 5 } } },
      [],
      "text",
      null,
    ];
    for (const c of cases) expect((await deliver(hub, SECRET, "issues", JSON.stringify(c))).status).toBe(400);
  });

  it("a duplicate delivery id is relayed once", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["9"]);
    const body = issue(ghRepo(9, "olive"));
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "dup-1" })).body).toEqual({ ok: true, notified: 1 });
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "dup-1" })).body).toEqual({ ok: true, notified: 0 });
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "dup-2" })).body).toEqual({ ok: true, notified: 1 });
    await sleep(100);
    expect(c.gh().map((m) => m.delivery)).toEqual(["dup-1", "dup-2"]);
  });

  it("forgets a delivery id after 10 minutes", async () => {
    let clock = Date.now();
    await hub.close();
    hub = await startTestHub({ now: () => clock });
    const o = await signInAs(hub, 1n, "olive");
    await hub.api(o)("PUT", "/admin/github-webhook", { secret: SECRET });
    const body = issue(ghRepo(9, "olive"));
    const c = await connect(o);
    await c.watch(["9"]);
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "old" })).body.notified).toBe(1);
    clock += 9 * 60_000;
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "old" })).body.notified).toBe(0);
    clock += 2 * 60_000;
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "old" })).body.notified).toBe(1);
  });

  it("shares one bucket of 600 per minute, then 429 with Retry-After", async () => {
    const body = issue(ghRepo(3, "o"));
    let ok = 0;
    for (let i = 0; i < 600; i += 50) {
      const rs = await Promise.all(Array.from({ length: 50 }, (_, j) => deliver(hub, SECRET, "issues", body, { delivery: `b-${i + j}` })));
      ok += rs.filter((r) => r.status === 200).length;
    }
    expect(ok).toBe(600);
    const r = await deliver(hub, SECRET, "issues", body, { delivery: "b-over" });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    // The refused delivery was not consumed: it is accepted when the bucket has room again (a duplicate answers before the bucket).
    expect((await deliver(hub, SECRET, "issues", body, { delivery: "b-1" })).status).toBe(200);
  }, 30_000);
});

describe("relay", () => {
  it("carries the payload verbatim with repoId, event and delivery", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["42"]);
    const body = issue(ghRepo(42, "olive", true), { sender: { login: "x" }, n: [1, 2, { a: null }] });
    await deliver(hub, SECRET, "issues", body, { delivery: "del-42" });
    const m = await c.waitFor((x) => x.t === "gh");
    expect(m).toEqual({ t: "gh", repoId: "42", event: "issues", delivery: "del-42", payload: body });
  });

  it("payload is null above 256 KiB and present at 256 KiB", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["42"]);
    const make = (n: number) => {
      const base = JSON.stringify({ repository: ghRepo(42, "olive"), pad: "" });
      return JSON.stringify({ repository: ghRepo(42, "olive"), pad: "x".repeat(n - base.length) });
    };
    const at = make(256 * 1024);
    const over = make(256 * 1024 + 1);
    expect(Buffer.byteLength(at)).toBe(256 * 1024);
    await deliver(hub, SECRET, "push", at, { delivery: "at" });
    await deliver(hub, SECRET, "push", over, { delivery: "over" });
    await c.waitFor((m) => m.delivery === "over");
    const [a, o] = c.gh();
    expect(a.delivery).toBe("at");
    expect((a.payload as { pad: string }).pad.length).toBeGreaterThan(256 * 1000);
    expect(o).toEqual({ t: "gh", repoId: "42", event: "push", delivery: "over", payload: null });
  });

  it("relays arrive in arrival order, immediately", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["42"]);
    const started = Date.now();
    for (let i = 0; i < 20; i++) await deliver(hub, SECRET, "issues", issue(ghRepo(42, "olive"), { i }), { delivery: `ord-${i}` });
    await c.waitFor((m) => m.delivery === "ord-19");
    expect(c.gh().map((m) => m.delivery)).toEqual(Array.from({ length: 20 }, (_, i) => `ord-${i}`));
    // No coalescing window: well under the 100 ms space window per message.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("reaches every allowed connection of the same member and notified counts sockets", async () => {
    const t = await signInAs(hub, 1n, "olive");
    const a = await connect(t);
    const b = await connect(t);
    await a.watch(["42"]);
    await b.watch(["42"]);
    expect((await deliver(hub, SECRET, "issues", issue(ghRepo(42, "olive")))).body).toEqual({ ok: true, notified: 2 });
    await a.waitFor((m) => m.t === "gh");
    await b.waitFor((m) => m.t === "gh");
  });
});

describe("audience", () => {
  it("public with a watcher, private with the owner's login (any case), shared in a readable space, restricted-unreadable, unrelated, unwatched", async () => {
    const olive = await signInAs(hub, 1n, "olive");
    const bob = await addMember(2n, "Bob");
    const carol = await addMember(3n, "carol");
    const dave = await addMember(4n, "dave");
    const cOlive = await connect(olive);
    const cBob = await connect(bob);
    const cCarol = await connect(carol);
    const cDave = await connect(dave);

    // 103 shared in the common space (number id), 106 (string id), 107 shared then deleted.
    await shareRepo(olive, "common", "r103", 103);
    await shareRepo(olive, "common", "r106", "106");
    await shareRepo(olive, "common", "r107", 107);
    await shareRepo(olive, "common", "r107", 107, "DELETE");
    // 104 shared only in a restricted space of olive and bob.
    const sp = await api("POST", "/admin/spaces", { name: "Secret", members: [{ githubId: "1", canWrite: true }, { githubId: "2", canWrite: true }] });
    expect(sp.status).toBe(201);
    await shareRepo(olive, sp.body.space.id, "r104", 104);

    const all = ["101", "102", "103", "104", "105", "106", "107", "108"];
    await cBob.watch(all);
    await cCarol.watch(all);
    await cOlive.watch(all);
    await cDave.watch([]); // connected, watches nothing

    const send = (id: number, owner: string, isPrivate: boolean) => deliver(hub, SECRET, "issues", issue(ghRepo(id, owner, isPrivate)), { delivery: `aud-${id}` });
    await send(101, "someone", false); // public: every watcher
    await send(102, "BOB", true); // private, owner login matches bob case-insensitively
    await send(103, "someone", true); // private, shared in common: all who can read common
    await send(104, "someone", true); // private, shared in restricted space: olive and bob only
    await send(105, "someone", true); // private, nobody: nobody
    await send(106, "someone", true); // string githubId in the entity
    await send(107, "someone", true); // entity deleted
    await send(108, "olive", true); // private owned by olive
    await cBob.watch(all); // barrier: handled after every relay above was queued
    await cCarol.watch(all);
    await cOlive.watch(all);

    const got = (c: Client) => c.gh().map((m) => m.repoId);
    expect(got(cBob)).toEqual(["101", "102", "103", "104", "106"]);
    expect(got(cCarol)).toEqual(["101", "103", "106"]);
    expect(got(cOlive)).toEqual(["101", "103", "104", "106", "108"]);
    expect(got(cDave)).toEqual([]);
  });

  it("a public repository without a watcher notifies nobody", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    expect((await deliver(hub, SECRET, "issues", issue(ghRepo(500, "x")))).body).toEqual({ ok: true, notified: 0 });
    await sleep(50);
    expect(c.gh()).toHaveLength(0);
  });

  it("a member who loses access to the space stops receiving a repository shared only there", async () => {
    const olive = await signInAs(hub, 1n, "olive");
    const bob = await addMember(2n, "bob");
    const sp = await api("POST", "/admin/spaces", { name: "S", members: [{ githubId: "1", canWrite: true }, { githubId: "2", canWrite: true }] });
    await shareRepo(olive, sp.body.space.id, "r1", 777);
    const c = await connect(bob);
    await c.watch(["777"]);
    expect((await deliver(hub, SECRET, "issues", issue(ghRepo(777, "x", true)))).body.notified).toBe(1);
    await api("PATCH", `/admin/spaces/${sp.body.space.id}`, { members: [{ githubId: "1", canWrite: true }] });
    expect((await deliver(hub, SECRET, "issues", issue(ghRepo(777, "x", true)))).body.notified).toBe(0);
  });

  it("a removed member gets nothing", async () => {
    const bob = await addMember(2n, "bob");
    const c = await connect(bob);
    await c.watch(["5"]);
    expect((await api("DELETE", "/admin/members/2")).status).toBe(204);
    await c.closed;
    expect((await deliver(hub, SECRET, "issues", issue(ghRepo(5, "x")))).body.notified).toBe(0);
  });
});

describe("watch", () => {
  it("replaces the watched set", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["1", "2"]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1, "x") })).body.notified).toBe(1);
    await c.watch(["2"]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1, "x") })).body.notified).toBe(0);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(2, "x") })).body.notified).toBe(1);
    await c.watch([]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(2, "x") })).body.notified).toBe(0);
  });

  it("is per connection", async () => {
    const t = await signInAs(hub, 1n, "olive");
    const a = await connect(t);
    const b = await connect(t);
    await a.watch(["1"]);
    await b.watch(["2"]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1, "x") })).body.notified).toBe(1);
    await sleep(50);
    expect(a.gh()).toHaveLength(1);
    expect(b.gh()).toHaveLength(0);
  });

  it("keeps at most 2000 ids and ignores the rest", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    const ids = Array.from({ length: 2001 }, (_, i) => String(1000 + i));
    await c.watch(ids); // a 2001-id message is about 45 KB, inside the client frame limit
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1000, "x") })).body.notified).toBe(1);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(2999, "x") })).body.notified).toBe(1);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(3000, "x") })).body.notified).toBe(0);
  });

  it("ignores other shapes and keeps the previous set", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["1"]);
    for (const repos of ["1", 1, null, { 0: "2" }, undefined]) {
      c.ws.send(JSON.stringify({ t: "watch", repos }));
    }
    c.ws.send("not json");
    c.ws.send("null");
    c.ws.send("[]");
    c.ws.send(JSON.stringify({ t: "watch" }));
    await c.watch(["1"], {}); // barrier, also resets to the same value
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1, "x") })).body.notified).toBe(1);
    // Non-string and malformed entries are dropped; valid ones are kept.
    await c.watch([5, null, "abc", "-3", "", "9", { a: 1 }]);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(9, "x") })).body.notified).toBe(1);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(5, "x") })).body.notified).toBe(0);
    expect((await deliver(hub, SECRET, "push", { repository: ghRepo(1, "x") })).body.notified).toBe(0);
  });

  it("a frame above 64 KiB closes the connection", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    c.ws.send(JSON.stringify({ t: "watch", repos: ["1"], pad: "x".repeat(65 * 1024) }));
    expect([1006, 1009]).toContain(await Promise.race([c.closed, sleep(3000).then(() => -1)]));
  });
});

describe("no bodies or secrets in logs or responses", () => {
  it("logs the event name, repository id and socket count only", async () => {
    const c = await connect(await signInAs(hub, 1n, "olive"));
    await c.watch(["42"]);
    const texts: string[] = [];
    const body = issue(ghRepo(42, "olive"), { comment: { body: "BODY-TEXT-77" } });
    const sigs: (string | null | undefined)[] = [undefined, "sha256=" + "a".repeat(64), null];
    for (const signature of sigs) {
      const r = await deliver(hub, SECRET, "issues", body, { signature, delivery: `h-${String(signature).slice(0, 12)}` });
      texts.push(JSON.stringify(r.body), JSON.stringify([...r.headers.entries()]));
    }
    await deliver(hub, SECRET, "issues", "{broken " + TITLE);
    await deliver(hub, SECRET, "issues", JSON.stringify({ title: TITLE }));
    for (const t of texts) {
      expect(t).not.toContain(TITLE);
      expect(t).not.toContain("BODY-TEXT-77");
      expect(t).not.toContain(SECRET);
    }
    const sigValue = signBody(SECRET, JSON.stringify(body));
    const logs = hub.logs.join("\n");
    expect(logs).not.toContain(TITLE);
    expect(logs).not.toContain("BODY-TEXT-77");
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(sigValue);
    expect(logs).not.toContain("a".repeat(64));
    const line = hub.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "github webhook" && l.event === "issues");
    expect(line).toEqual({ level: "info", msg: "github webhook", event: "issues", repoId: "42", notified: 1 });
  });
});
