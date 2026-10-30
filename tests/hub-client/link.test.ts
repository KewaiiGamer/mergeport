import { describe, expect, it } from "vitest";
import { HubLink, type HubLinkState, type SocketLike } from "@/lib/hub/link";
import { ManualTimers } from "./manual-timers";

class ScriptSocket implements SocketLike {
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  sent: string[] = [];
  closedWith: number | undefined;
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
  }
  open() {
    this.onopen?.();
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(opts: { token?: string | null; origin?: string } = {}) {
  const timers = new ManualTimers();
  const sockets: ScriptSocket[] = [];
  const log = { changed: [] as [string, bigint][], access: [] as [string, string][], team: [] as string[], hello: [] as { id: string; seq: bigint }[][], states: [] as HubLinkState[] };
  const link = new HubLink({
    origin: opts.origin ?? "https://hub.example.com",
    getToken: async () => (opts.token === undefined ? "secret-token" : opts.token),
    connect: (url, protocols) => {
      const s = new ScriptSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    timers,
    random: () => 0.5,
    onChanged: (id, seq) => log.changed.push([id, seq]),
    onAccess: (id, a) => log.access.push([id, a]),
    onTeam: (r) => log.team.push(r),
    onHello: (s) => log.hello.push(s),
    onState: (s) => log.states.push(s),
  });
  const last = () => sockets[sockets.length - 1];
  return { timers, sockets, log, link, last };
}

describe("HubLink", () => {
  it("sends the bearer in the subprotocols and never in the URL", async () => {
    const t = setup();
    t.link.start();
    await flush();
    expect(t.sockets).toHaveLength(1);
    expect(t.last().url).toBe("wss://hub.example.com/ws");
    expect(t.last().url).not.toContain("secret-token");
    expect(t.last().protocols).toEqual(["mergeport.v1", "bearer.secret-token"]);
  });

  it("maps http to ws", async () => {
    const t = setup({ origin: "http://127.0.0.1:8080/" });
    t.link.start();
    await flush();
    expect(t.last().url).toBe("ws://127.0.0.1:8080/ws");
  });

  it("missing token: signed-out, no connection, no timer", async () => {
    const t = setup({ token: null });
    t.link.start();
    await flush();
    expect(t.link.state).toBe("signed-out");
    expect(t.sockets).toHaveLength(0);
    expect(t.timers.pending).toBe(0);
  });

  it("hello makes it live and reports spaces with bigint seq", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [{ id: "common", seq: "7" }] });
    expect(t.link.state).toBe("live");
    expect(t.log.hello).toEqual([[{ id: "common", seq: 7n }]]);
  });

  it("backoff doubles 1 s, 2 s, 4 s ... capped at 30 s (random 0.5 means x1)", async () => {
    const t = setup();
    t.link.start();
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = t.timers.scheduled.length;
      t.last().drop();
      delays.push(t.timers.scheduled[before]);
      t.timers.advance(delays[i]);
      await flush();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(t.sockets).toHaveLength(9);
  });

  it("jitter scales the delay by 0.5 + random()", async () => {
    const timers = new ManualTimers();
    const socks: ScriptSocket[] = [];
    const link = new HubLink({
      origin: "https://h",
      getToken: async () => "t",
      connect: (u, p) => {
        socks.push(new ScriptSocket(u, p));
        return socks[socks.length - 1];
      },
      timers,
      random: () => 1,
      onChanged() {},
      onAccess() {},
      onTeam() {},
    });
    link.start();
    await flush();
    socks[0].drop();
    expect(timers.scheduled).toEqual([1500]);
  });

  it("the delay is clamped to 30 s after jitter is applied", async () => {
    const timers = new ManualTimers();
    const socks: ScriptSocket[] = [];
    const link = new HubLink({
      origin: "https://h",
      getToken: async () => "t",
      connect: (u, p) => {
        socks.push(new ScriptSocket(u, p));
        return socks[socks.length - 1];
      },
      timers,
      random: () => 0.99,
      onChanged() {},
      onAccess() {},
      onTeam() {},
    });
    link.start();
    await flush();
    for (let i = 0; i < 8; i++) {
      socks[socks.length - 1].drop();
      timers.advance(30_000);
      await flush();
    }
    expect(timers.scheduled).toEqual([1490, 2980, 5960, 11920, 23840, 30000, 30000, 30000]);
  });

  it("backoff resets after hello", async () => {
    const t = setup();
    t.link.start();
    await flush();
    for (let i = 0; i < 3; i++) {
      t.last().drop();
      t.timers.advance(30_000);
      await flush();
    }
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    const before = t.timers.scheduled.length;
    t.last().drop();
    expect(t.timers.scheduled[before]).toBe(1000);
  });

  it("goes reconnecting after a drop and offline after repeated failures", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    t.last().drop();
    expect(t.link.state).toBe("reconnecting");
    for (let i = 0; i < 3; i++) {
      t.timers.advance(30_000);
      await flush();
      t.last().drop();
    }
    expect(t.link.state).toBe("offline");
  });

  it("pings every 25 s while open, and not after a drop", async () => {
    const t = setup();
    t.link.start();
    await flush();
    const s = t.last();
    s.open();
    t.timers.advance(24_999);
    expect(s.sent).toEqual([]);
    t.timers.advance(1);
    expect(s.sent).toEqual([JSON.stringify({ t: "ping" })]);
    t.timers.advance(50_000);
    expect(s.sent).toHaveLength(3);
    s.drop();
    t.timers.advance(24_000);
    expect(s.sent).toHaveLength(3);
  });

  it("a burst of five changed within 100 ms is one onChanged with the highest seq", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    for (const seq of ["3", "4", "9", "5", "6"]) t.last().msg({ t: "changed", spaceId: "common", seq });
    t.timers.advance(99);
    expect(t.log.changed).toEqual([]);
    t.timers.advance(1);
    expect(t.log.changed).toEqual([["common", 9n]]);
    t.last().msg({ t: "changed", spaceId: "common", seq: "10" });
    t.timers.advance(100);
    expect(t.log.changed).toEqual([["common", 9n], ["common", 10n]]);
  });

  it("two spaces give two callbacks", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "changed", spaceId: "a", seq: "1" });
    t.last().msg({ t: "changed", spaceId: "b", seq: "2" });
    t.timers.advance(100);
    expect(t.log.changed).toEqual([["a", 1n], ["b", 2n]]);
  });

  it("malformed messages are ignored and never throw out of onmessage", async () => {
    const t = setup();
    t.link.start();
    await flush();
    const s = t.last();
    expect(() => {
      s.onmessage?.({ data: "not json" });
      s.msg({ t: "hello", spaces: [{ id: "a", seq: "x" }] });
      s.msg({ t: "changed", spaceId: "a", seq: "nope" });
      s.msg({ t: "changed", spaceId: "a" });
    }).not.toThrow();
    expect(t.log.changed).toEqual([]);
    expect(t.timers.pending).toBe(0);
    s.msg({ t: "hello", spaces: [] });
    expect(t.link.state).toBe("live");
  });

  it("forwards access and team messages", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().msg({ t: "access", spaceId: "secret", action: "added" });
    t.last().msg({ t: "team", reason: "role" });
    expect(t.log.access).toEqual([["secret", "added"]]);
    expect(t.log.team).toEqual(["role"]);
  });

  it("close code 4403 means removed: no reconnect, no timer left", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "hello", spaces: [] });
    t.last().drop(4403);
    expect(t.link.state).toBe("removed");
    expect(t.timers.pending).toBe(0);
    t.timers.advance(10 * 60_000);
    await flush();
    expect(t.sockets).toHaveLength(1);
  });

  it("bye removed means removed and closes the socket; bye shutdown reconnects", async () => {
    const a = setup();
    a.link.start();
    await flush();
    a.last().msg({ t: "hello", spaces: [] });
    const sock = a.last();
    sock.msg({ t: "bye", reason: "removed" });
    expect(a.link.state).toBe("removed");
    expect(sock.closedWith).toBeDefined();
    expect(a.timers.pending).toBe(0);

    const b = setup();
    b.link.start();
    await flush();
    b.last().msg({ t: "hello", spaces: [] });
    b.last().msg({ t: "bye", reason: "shutdown" });
    expect(b.link.state).toBe("reconnecting");
    b.timers.advance(1000);
    await flush();
    expect(b.sockets).toHaveLength(2);
  });

  it("a late event from a dropped socket is ignored", async () => {
    const t = setup();
    t.link.start();
    await flush();
    const old = t.last();
    old.drop();
    old.msg({ t: "hello", spaces: [] });
    expect(t.link.state).toBe("reconnecting");
  });

  it("stop clears every timer, drops the socket and does not reconnect", async () => {
    const t = setup();
    t.link.start();
    await flush();
    t.last().open();
    t.last().msg({ t: "changed", spaceId: "a", seq: "1" });
    expect(t.timers.pending).toBeGreaterThan(0);
    const s = t.last();
    t.link.stop();
    expect(t.timers.pending).toBe(0);
    expect(s.closedWith).toBeDefined();
    t.timers.advance(60_000);
    await flush();
    expect(t.log.changed).toEqual([]);
    expect(t.sockets).toHaveLength(1);
  });

  it("stop during the token lookup connects nothing", async () => {
    const t = setup();
    t.link.start();
    t.link.stop();
    await flush();
    expect(t.sockets).toHaveLength(0);
  });
});
