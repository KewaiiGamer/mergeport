import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubBackendId } from "@/lib/local/backends";
import { readActive } from "@/lib/local/registry";
import { resetEnvCache } from "@/lib/env";
import type { GhStatus } from "@/lib/github/gh";
import { FAKE_DEVICE_CODE, FAKE_POLL_SECRET, startFakeHub } from "./fake-hub";
import { resetDeviceFlows } from "@/lib/hub/device-flows";

const m = vi.hoisted(() => ({ gh: null as unknown, requestSwitch: vi.fn() }));
vi.mock("@/lib/local/identity", () => ({ currentGhStatus: async () => m.gh }));
vi.mock("@/lib/local/switch-client", () => ({ requestSwitch: m.requestSwitch }));

import { POST as check } from "@/app/api/local/hub/check/route";
import { POST as start } from "@/app/api/local/hub/start/route";
import { POST as poll } from "@/app/api/local/hub/poll/route";

const ghOk = (id: bigint): GhStatus => ({ state: "ok", identity: { id, login: "octocat", name: null, avatarUrl: null, host: "github.com" } });
const GH_URI = "https://github.com/login/device";
const hubs: { stop(): Promise<void> }[] = [];
let home: string;
const hub = async (o: Parameters<typeof startFakeHub>[0] = {}) => {
  const h = await startFakeHub({ verificationUri: GH_URI, githubId: "42", ...o });
  hubs.push(h);
  return h;
};
const req = (p: string, body: unknown, headers: Record<string, string> = { origin: "http://127.0.0.1:3000" }) =>
  new Request(`http://127.0.0.1:3000/api/local/hub/${p}`, { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-hubroutes-"));
  process.env.MERGEPORT_HOME = home;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  m.gh = ghOk(42n);
  resetDeviceFlows();
  m.requestSwitch.mockReset();
  m.requestSwitch.mockResolvedValue({ launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old" });
});
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  delete process.env.MERGEPORT_HOME;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

/** Starts a flow through the route and returns the browser's view of it. */
const begin = async (origin: string) => (await (await start(req("start", { url: origin }))).json()) as { ok: true; pollId: string; userCode: string; verificationUri: string; interval: number };

describe("hub connect routes", () => {
  it("refuse cross-origin and demo mode", async () => {
    const h = await hub();
    for (const r of [check, start, poll]) expect((await r(req("x", { url: h.origin, pollId: "p" }, { origin: "http://evil.example" }))).status).toBe(403);
    process.env.DEMO_MODE = "true";
    resetEnvCache();
    for (const r of [check, start, poll]) expect((await r(req("x", { url: h.origin, pollId: "p" }))).status).toBe(403);
    expect(h.requests.length).toBe(0);
  });

  it("refuse a Host that is not this loopback server even when Origin matches it (DNS rebinding)", async () => {
    const h = await hub();
    for (const host of ["evil.example", "evil.example:3000", "127.0.0.1:3001", "localhost"]) {
      for (const r of [check, start, poll]) expect((await r(req("x", { url: h.origin, pollId: "p" }, { host, origin: `http://${host}` }))).status).toBe(403);
    }
    for (const host of ["localhost:3000", "[::1]:3000"]) expect((await check(req("check", { url: h.origin }, { host, origin: `http://${host}` }))).status).toBe(200);
    expect(h.requests.filter((r) => r.path !== "/health").length).toBe(0);
  });

  it("check returns team and origin; mismatched publicUrl and bad input give ok:false", async () => {
    const h = await hub();
    expect(await (await check(req("check", { url: h.origin + "/" }))).json()).toEqual({ ok: true, teamName: "Fake Team", origin: h.origin });
    const bad = await hub({ publicUrl: "https://elsewhere.example.com" });
    expect(await (await check(req("check", { url: bad.origin }))).json()).toMatchObject({ ok: false });
    expect(await (await check(req("check", { url: 5 }))).json()).toMatchObject({ ok: false });
    expect(await (await check(req("check", { url: "http://example.com" }))).json()).toMatchObject({ ok: false });
  });

  it("start returns the user code, a validated verification uri and an opaque poll id; never the device code or poll secret", async () => {
    const h = await hub();
    const res = await start(req("start", { url: h.origin }));
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, userCode: "ABCD-1234", verificationUri: GH_URI, interval: 1, pollId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(text).not.toContain(FAKE_DEVICE_CODE);
    expect(text).not.toContain(FAKE_POLL_SECRET);
  });

  it("poll with an unknown poll id is 400 and never reaches the hub", async () => {
    const h = await hub();
    const res = await poll(req("poll", { pollId: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "error", error: "bad-request" });
    expect(h.requests.filter((r) => r.path === "/auth/device/poll")).toHaveLength(0);
  });

  it("start refuses a verification uri on another host", async () => {
    for (const verificationUri of ["https://evil.example/login/device", "http://github.com/login/device", "javascript:alert(1)"]) {
      const h = await hub({ verificationUri });
      const j = await (await start(req("start", { url: h.origin }))).json();
      expect(j.ok).toBe(false);
      expect(JSON.stringify(j)).not.toContain("evil.example");
      expect(JSON.stringify(j)).not.toContain("dev-code-secret");
    }
  });

  it("start then pending then ok switches once, leaves active.json to the launcher, and never leaks the session", async () => {
    const h = await hub({ slowDownPolls: 1, pollsBeforeOk: 1 });
    const s = await begin(h.origin);
    expect(await (await poll(req("poll", { pollId: s.pollId }))).json()).toEqual({ status: "pending", slowDown: true });
    expect(await (await poll(req("poll", { pollId: s.pollId }))).json()).toEqual({ status: "pending" });
    const res = await poll(req("poll", { pollId: s.pollId }));
    const text = await res.text();
    // The local app, not the browser, holds the device code and poll secret and sends them to the hub.
    expect(h.requests.filter((r) => r.path === "/auth/device/poll").map((r) => r.body)).toEqual(Array(3).fill({ deviceCode: FAKE_DEVICE_CODE, pollSecret: FAKE_POLL_SECRET }));
    const backend = hubBackendId(h.origin);
    expect(JSON.parse(text)).toEqual({ status: "ok", switch: { launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old", expectedBackend: backend } });
    expect(text).not.toContain("session-token-secret");
    expect(readActive(home)).toBeNull(); // a failed switch must leave the next launch on the previous workspace
    expect(m.requestSwitch).toHaveBeenCalledTimes(1);
    expect(m.requestSwitch).toHaveBeenCalledWith(backend);
    expect((await poll(req("poll", { pollId: s.pollId }))).status).toBe(400); // a finished flow is forgotten
  });

  it("gh as another account gives mismatch and no files", async () => {
    const h = await hub();
    m.gh = ghOk(43n);
    const j = await (await poll(req("poll", { pollId: (await begin(h.origin)).pollId }))).json();
    expect(j).toEqual({ status: "error", error: "mismatch" });
    expect(fs.readdirSync(home)).toEqual([]);
    expect(m.requestSwitch).not.toHaveBeenCalled();
  });

  it("maps refusals and expiry", async () => {
    const a = await hub({ invited: false });
    expect(await (await poll(req("poll", { pollId: (await begin(a.origin)).pollId }))).json()).toEqual({ status: "refused", reason: "not-invited" });
    const b = await hub({ removed: true });
    expect(await (await poll(req("poll", { pollId: (await begin(b.origin)).pollId }))).json()).toEqual({ status: "refused", reason: "removed" });
    const c = await hub({ expired: true });
    expect(await (await poll(req("poll", { pollId: (await begin(c.origin)).pollId }))).json()).toEqual({ status: "expired" });
  });

  it("reports a failed switch without leaking", async () => {
    const h = await hub();
    m.requestSwitch.mockRejectedValue(new Error("Switching needs the launcher. Start Mergeport with npm run local."));
    const j = await (await poll(req("poll", { pollId: (await begin(h.origin)).pollId }))).json();
    expect(j).toMatchObject({ status: "error", error: "switch" });
    expect(JSON.stringify(j)).not.toContain("session-token-secret");
  });
});
