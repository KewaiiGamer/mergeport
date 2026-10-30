import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HttpHubClient, checkHubHealth, normalizeHubOrigin } from "@/lib/hub/client";
import { HubError, type Op } from "@/lib/hub/types";
import { FakeHub } from "./fake-hub";

describe("normalizeHubOrigin", () => {
  it("lowercases host and drops path", () => {
    expect(normalizeHubOrigin("https://Hub.Example.com/x/")).toBe("https://hub.example.com");
  });
  it("rejects plain http except loopback", () => {
    expect(() => normalizeHubOrigin("http://hub.example.com")).toThrow(HubError);
    expect(normalizeHubOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeHubOrigin("http://localhost:1")).toBe("http://localhost:1");
    expect(normalizeHubOrigin("http://[::1]:1")).toBe("http://[::1]:1");
  });
});

const op = (opId: string, baseVersion: number, data: Record<string, unknown> = { title: "a" }): Op => ({ opId, type: "task", entityId: "t1", kind: "UPSERT", baseVersion, data });

describe("request deadline", () => {
  /** A fetch that never answers on its own and only ends when its signal aborts, like a connection a proxy silently dropped. */
  const hung = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_ok, fail) => {
      init?.signal?.addEventListener("abort", () => fail(init.signal!.reason));
    })) as unknown as typeof fetch;

  it("a hung pull fails as a network error after the deadline instead of waiting forever", async () => {
    const client = new HttpHubClient("http://127.0.0.1:1", async () => "t", hung, { request: 80 });
    const t0 = Date.now();
    await expect(client.pull("common", 0n)).rejects.toMatchObject({ kind: "network" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("push and snapshot use the longer bulk deadline, me() the short one", async () => {
    const client = new HttpHubClient("http://127.0.0.1:1", async () => "t", hung, { request: 60, bulk: 400 });
    const timed = async (f: () => Promise<unknown>) => {
      const t0 = Date.now();
      await expect(f()).rejects.toMatchObject({ kind: "network" });
      return Date.now() - t0;
    };
    const quick = await timed(() => client.me());
    const slow = await timed(() => client.push("common", [op("o1", 0)]));
    const slowSnap = await timed(() => client.snapshot("common"));
    expect(quick).toBeLessThan(300);
    expect(slow).toBeGreaterThanOrEqual(350);
    expect(slowSnap).toBeGreaterThanOrEqual(350);
  });
});

describe("redirects", () => {
  it("a 302 is a HubError and the bearer is never replayed", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
      res.end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(new HttpHubClient(origin, async () => "tok").me()).rejects.toBeInstanceOf(HubError);
      await expect(checkHubHealth(origin)).rejects.toBeInstanceOf(HubError);
      expect(seen).toEqual(["/me", "/health"]);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});

describe("HttpHubClient against FakeHub", () => {
  let hub: FakeHub;
  let url: string;
  let token: string | null;
  let client: HttpHubClient;
  beforeEach(async () => {
    hub = new FakeHub();
    hub.addMember("1", "alice", "ADMIN");
    hub.createSpace("common", "COMMON", "Common");
    token = hub.token("1");
    url = (await hub.listen()).url;
    client = new HttpHubClient(url, async () => token);
  });
  afterEach(async () => {
    await hub.close();
  });

  it("me lists spaces with parsed seq", async () => {
    const me = await client.me();
    expect(me.member.login).toBe("alice");
    expect(me.spaces[0]).toMatchObject({ id: "common", canWrite: true, seq: "0" });
  });

  it("push applies, duplicates and goes stale", async () => {
    const r1 = await client.push("common", [op("o1", 0)]);
    expect(r1.results[0]).toMatchObject({ status: "applied", version: 1 });
    expect(r1.seq).toBe(1n);
    const r2 = await client.push("common", [op("o1", 0)]);
    expect(r2.results[0].status).toBe("duplicate");
    const r3 = await client.push("common", [op("o2", 0, { title: "b" })]);
    expect(r3.results[0].status).toBe("stale");
    expect(r3.results[0].current?.version).toBe(1);
  });

  it("pull returns events with bigint seq, gone after prune", async () => {
    await client.push("common", [op("o1", 0)]);
    const p = await client.pull("common", 0n);
    if (p === "gone" || p === "history") throw new Error("unexpected " + p);
    expect(p.seq).toBe(1n);
    expect(p.events[0].seq).toBe(1n);
    expect(p.events[0].opId).toBe("o1");
    await client.push("common", [op("o2", 1, { title: "c" })]);
    hub.pruneBefore(2n);
    expect(await client.pull("common", 0n)).toBe("gone");
    expect(await client.pull("common", 2n)).toMatchObject({ seq: 2n, events: [] });
    const snap = await client.snapshot("common");
    expect(snap.seq).toBe(2n);
    expect(snap.entities[0].version).toBe(2);
  });

  it("maps errors", async () => {
    token = null;
    await expect(client.me()).rejects.toMatchObject({ kind: "auth" });
    token = "bogus";
    await expect(client.me()).rejects.toMatchObject({ kind: "auth" });
    token = hub.token("1");
    await expect(client.pull("nope", 0n)).rejects.toMatchObject({ kind: "not-found" });
    hub.removeMember("1");
    await expect(client.me()).rejects.toMatchObject({ kind: "forbidden" });
    await hub.close();
    await expect(client.me()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("checkHubHealth", () => {
  let hub: FakeHub;
  let url: string;
  beforeEach(async () => {
    hub = new FakeHub();
    url = (await hub.listen()).url;
  });
  afterEach(async () => {
    await hub.close();
  });
  it("accepts a good hub", async () => {
    expect(await checkHubHealth(url)).toMatchObject({ publicUrl: url, githubHost: "github.com" });
  });
  it("refuses newer schema, url mismatch, other github host", async () => {
    hub.setSchema(2);
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "schema" });
    hub.setSchema(1);
    hub.publicUrl = "https://elsewhere.example.com";
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "unknown" });
    hub.publicUrl = undefined;
    hub.githubHost = "ghe.example.com";
    await expect(checkHubHealth(url)).rejects.toMatchObject({ kind: "unknown" });
  });
});
