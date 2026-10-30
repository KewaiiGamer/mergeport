import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLimiter } from "../../hub/src/ratelimit";
import { clientIp } from "../../hub/src/auth-routes";
import { signInAs, startTestHub, type TestHub } from "./harness";

describe("createLimiter", () => {
  it("allows up to the limit, then reports retryAfterSec", () => {
    let t = 1000;
    const l = createLimiter(() => t);
    for (let i = 0; i < 3; i++) expect(l.take("k", 3, 10_000)).toEqual({ ok: true });
    t += 2500;
    expect(l.take("k", 3, 10_000)).toEqual({ ok: false, retryAfterSec: 8 });
    t += 7500;
    expect(l.take("k", 3, 10_000)).toEqual({ ok: true });
  });
  it("keys are independent", () => {
    const l = createLimiter(() => 0);
    expect(l.take("a", 1, 1000).ok).toBe(true);
    expect(l.take("b", 1, 1000).ok).toBe(true);
    expect(l.take("a", 1, 1000).ok).toBe(false);
  });
  it("evicts idle keys so memory does not grow without bound", () => {
    let t = 0;
    const l = createLimiter(() => t);
    for (let i = 0; i < 500; i++) l.take(`k${i}`, 5, 10_000);
    expect(l.size()).toBe(500);
    t += 60_000;
    l.take("fresh", 5, 10_000);
    expect(l.size()).toBe(1);
  });
});

describe("rate limits over HTTP", () => {
  let hub: TestHub;
  let clock: number;
  beforeEach(async () => {
    clock = Date.UTC(2026, 9, 29);
    hub = await startTestHub({ now: () => clock });
  });
  afterEach(async () => {
    await hub.close();
  });

  it("61st authenticated request within 10 s is 429 with Retry-After", async () => {
    const token = await signInAs(hub, 1n, "olive");
    const api = hub.api(token);
    let ok = 0;
    for (let i = 0; i < 60; i++) if ((await api("GET", "/me")).status === 200) ok++;
    expect(ok).toBe(60);
    const r = await api("GET", "/me");
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "rate limited" });
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    clock += 10_001;
    expect((await api("GET", "/me")).status).toBe(200);
  });

  it("limit is per session", async () => {
    const a = await signInAs(hub, 1n, "olive");
    const b = await signInAs(hub, 1n, "olive");
    for (let i = 0; i < 61; i++) await hub.api(a)("GET", "/me");
    expect((await hub.api(a)("GET", "/me")).status).toBe(429);
    expect((await hub.api(b)("GET", "/me")).status).toBe(200);
  });

  it("11th device start per IP per minute is 429", async () => {
    for (let i = 0; i < 10; i++) expect((await hub.api()("POST", "/auth/device/start")).status).toBe(200);
    const r = await hub.api()("POST", "/auth/device/start");
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "rate limited" });
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    clock += 60_001;
    expect((await hub.api()("POST", "/auth/device/start")).status).toBe(200);
  });

  it("X-Forwarded-For rightmost entry (the one the proxy appended) is the key when trustProxy", async () => {
    const start = (xff: string) => fetch(hub.url + "/auth/device/start", { method: "POST", headers: { "x-forwarded-for": xff } });
    // A client that puts a fresh fake address first on every request is still one client to the proxy.
    for (let i = 0; i < 10; i++) expect((await start(`10.${i}.0.1, 203.0.113.5`)).status).toBe(200);
    expect((await start("10.99.0.1, 203.0.113.5")).status).toBe(429);
    expect((await start("203.0.113.5 ,")).status).toBe(429); // trailing comma and spaces do not make a new key
    expect((await start("203.0.113.6")).status).toBe(200);
    expect((await start("10.0.0.1, 203.0.113.7")).status).toBe(200);
  });

  it("clientIp takes the rightmost entry, joins repeated headers, and falls back to the socket", () => {
    const req = (xff: string | string[] | undefined) => ({ headers: { "x-forwarded-for": xff }, socket: { remoteAddress: "127.0.0.1" } }) as unknown as import("node:http").IncomingMessage;
    expect(clientIp(req("1.1.1.1, 2.2.2.2, 3.3.3.3"), true)).toBe("3.3.3.3");
    expect(clientIp(req(["1.1.1.1, 2.2.2.2", "3.3.3.3"]), true)).toBe("3.3.3.3");
    expect(clientIp(req(" 4.4.4.4 "), true)).toBe("4.4.4.4");
    expect(clientIp(req(""), true)).toBe("127.0.0.1");
    expect(clientIp(req(undefined), true)).toBe("127.0.0.1");
    expect(clientIp(req("1.1.1.1, 2.2.2.2"), false)).toBe("127.0.0.1");
  });
});

describe("X-Forwarded-For without trustProxy", () => {
  it("is ignored: the socket address is the key", async () => {
    const hub = await startTestHub({ trustProxy: false });
    try {
      const start = (ip: string) => fetch(hub.url + "/auth/device/start", { method: "POST", headers: { "x-forwarded-for": ip } });
      for (let i = 0; i < 10; i++) expect((await start(`203.0.113.${i}`)).status).toBe(200);
      expect((await start("198.51.100.1")).status).toBe(429);
    } finally {
      await hub.close();
    }
  });
});
