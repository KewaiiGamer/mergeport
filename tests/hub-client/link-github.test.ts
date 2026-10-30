import { describe, expect, it } from "vitest";
import { HubLink, type SocketLike } from "@/lib/hub/link";
import { ManualTimers } from "./manual-timers";

class ScriptSocket implements SocketLike {
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: string[] = [];
  send(d: string) {
    this.sent.push(d);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  raw(d: string) {
    this.onmessage?.({ data: d });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
  get watches() {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.t === "watch");
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));
type Ev = { repoId: string; event: string; delivery: string; payload: unknown | null };

function setup(watched: () => string[] = () => ["1296269", "42"]) {
  const timers = new ManualTimers();
  const sockets: ScriptSocket[] = [];
  const events: Ev[] = [];
  const link: HubLink = new HubLink({
    origin: "https://hub.example.com",
    getToken: async () => "secret-token",
    connect: () => {
      const s = new ScriptSocket();
      sockets.push(s);
      return s;
    },
    timers,
    random: () => 0.5,
    onChanged: () => {},
    onAccess: () => {},
    onTeam: () => {},
    // what live.ts does: the owner of the link sends the tracked set after every hello
    onHello: () => link.watch(watched()),
    onGithubEvent: (e) => events.push(e),
  });
  return { timers, sockets, events, link, last: () => sockets[sockets.length - 1] };
}

describe("HubLink: GitHub relays and watch", () => {
  it("hands a gh message to onGithubEvent with its payload", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    const payload = { action: "opened", issue: { number: 7 } };
    t.last().msg({ t: "gh", repoId: "1296269", event: "issues", delivery: "abc-1", payload });
    t.last().msg({ t: "gh", repoId: "1296269", event: "push", delivery: "abc-2", payload: null });
    expect(t.events).toEqual([
      { repoId: "1296269", event: "issues", delivery: "abc-1", payload },
      { repoId: "1296269", event: "push", delivery: "abc-2", payload: null },
    ]);
  });

  it("keeps relays in arrival order", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    for (let i = 0; i < 25; i++) t.last().msg({ t: "gh", repoId: "1", event: "issues", delivery: `d${i}`, payload: { i } });
    expect(t.events.map((e) => e.delivery)).toEqual(Array.from({ length: 25 }, (_, i) => `d${i}`));
  });

  it("a gh message without a payload field counts as payload null (the app then fetches)", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().msg({ t: "gh", repoId: "1", event: "issues", delivery: "d" });
    expect(t.events[0].payload).toBeNull();
  });

  it.each([
    ["repoId a number", { t: "gh", repoId: 1, event: "issues", delivery: "d", payload: {} }],
    ["no event", { t: "gh", repoId: "1", delivery: "d", payload: {} }],
    ["no delivery", { t: "gh", repoId: "1", event: "issues", payload: {} }],
    ["event an object", { t: "gh", repoId: "1", event: {}, delivery: "d" }],
  ])("ignores a malformed gh message (%s) and keeps working", async (_n, bad) => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().raw("not json");
    t.last().msg(bad);
    t.last().msg({ t: "gh", repoId: "1", event: "issues", delivery: "ok", payload: {} });
    expect(t.events.map((e) => e.delivery)).toEqual(["ok"]);
  });

  it("an onGithubEvent that throws never throws out of onmessage", async () => {
    const link = new HubLink({
      origin: "https://hub.example.com",
      getToken: async () => "t",
      connect: () => (s = new ScriptSocket()),
      timers: new ManualTimers(),
      onChanged() {},
      onAccess() {},
      onTeam() {},
      onGithubEvent: () => {
        throw new Error("boom");
      },
    });
    let s!: ScriptSocket;
    link.start();
    await flush();
    expect(() => s.msg({ t: "gh", repoId: "1", event: "issues", delivery: "d", payload: {} })).not.toThrow();
  });

  it("sends watch after hello with the tracked set, and only then", async () => {
    const t = setup(() => ["1296269", "42"]);
    t.link.start();
    await flush();
    t.last().open();
    expect(t.last().watches).toEqual([]); // nothing before hello
    t.last().msg({ t: "hello", spaces: [] });
    expect(t.last().watches).toEqual([{ t: "watch", repos: ["1296269", "42"] }]);
  });

  it("sends the set again after a reconnect's hello", async () => {
    let set = ["1"];
    const t = setup(() => set);
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    const first = t.last();
    set = ["1", "2"];
    first.drop();
    t.timers.advance(5000);
    await flush();
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    expect(t.last().watches).toEqual([{ t: "watch", repos: ["1", "2"] }]);
  });

  it("watch() replaces the set when the tracked set changes while open", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    t.link.watch(["7"]);
    t.link.watch([]);
    expect(t.last().watches.map((w) => w.repos)).toEqual([["1296269", "42"], ["7"], []]);
  });

  it("sends nothing while the socket is closed or not yet open, and after stop", async () => {
    const t = setup();
    t.link.watch(["1"]); // never started
    t.link.start();
    await flush();
    t.link.watch(["1"]); // connecting: not open yet
    expect(t.last().sent).toEqual([]);
    expect(t.link.isOpen).toBe(false);
    t.last().open();
    expect(t.link.isOpen).toBe(true);
    const s = t.last();
    s.drop();
    expect(t.link.isOpen).toBe(false);
    t.link.watch(["1"]);
    expect(s.sent).toEqual([]);
    t.link.stop();
    t.link.watch(["1"]);
    expect(s.sent).toEqual([]);
  });

  it("a send that throws does not throw out of watch", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().send = () => {
      throw new Error("closed");
    };
    expect(() => t.link.watch(["1"])).not.toThrow();
  });
});
