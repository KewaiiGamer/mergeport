import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubBackendId } from "@/lib/local/backends";
import { readActive, writeActive } from "@/lib/local/registry";
import { profileDbPath, ensureLocalProfile, AccountMismatchError } from "@/lib/local/profile";
import { resolveStartProfile, resolveSwitchTarget } from "@/lib/local/start-profile";
import { waitForReady } from "@/lib/local/child-process";
import { createPrisma } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";

const sess = vi.hoisted(() => ({ session: { user: { githubId: 7n } } as { user: { githubId: bigint } } | null }));
const sw = vi.hoisted(() => ({ requestSwitch: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), findSession: async () => sess.session }));

import { GET as readyGet } from "@/app/api/local/ready/route";
import { POST } from "@/app/api/local/switch/route";

vi.mock("@/lib/local/switch-client", async (orig) => ({ ...(await orig<typeof import("@/lib/local/switch-client")>()), requestSwitch: sw.requestSwitch }));

const HUB = hubBackendId("https://hub.example.com");
const ready = (host = "127.0.0.1:3000") => new Request("http://127.0.0.1:3000/api/local/ready", { headers: { host } });
let home: string;
const post = (body: unknown, headers: Record<string, string> = { origin: "http://127.0.0.1:3000" }) =>
  new Request("http://127.0.0.1:3000/api/local/switch", { method: "POST", headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-switch-"));
  process.env.MERGEPORT_HOME = home;
  resetEnvCache();
  sess.session = { user: { githubId: 7n } };
  sw.requestSwitch.mockReset();
});
afterEach(() => {
  delete process.env.MERGEPORT_HOME;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("requestSwitch", () => {
  it("throws the launcher message when the control env is unset", async () => {
    const real = await vi.importActual<typeof import("@/lib/local/switch-client")>("@/lib/local/switch-client");
    await expect(real.requestSwitch(HUB, { env: {} })).rejects.toThrow("Switching needs the launcher. Start Mergeport with npm run local.");
  });
  it("throws the launcher message when the launch token is unset", async () => {
    const real = await vi.importActual<typeof import("@/lib/local/switch-client")>("@/lib/local/switch-client");
    await expect(real.requestSwitch(HUB, { env: { MERGEPORT_CONTROL_URL: "http://127.0.0.1:9" } })).rejects.toThrow("Switching needs the launcher. Start Mergeport with npm run local.");
  });
  it("posts to the control channel with this child's launch token and returns the launch url", async () => {
    const real = await vi.importActual<typeof import("@/lib/local/switch-client")>("@/lib/local/switch-client");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ launchUrl: "http://127.0.0.1:3000/api/local/launch?token=x" }), { status: 200 }));
    const r = await real.requestSwitch(HUB, { env: { MERGEPORT_CONTROL_URL: "http://127.0.0.1:9", MERGEPORT_LAUNCH_TOKEN: "s3" }, fetch: fetchMock as unknown as typeof fetch });
    expect(r.launchUrl).toContain("token=x");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/switch");
    expect((init.headers as Record<string, string>)["x-mergeport-control"]).toBe("s3");
    expect(JSON.parse(init.body as string)).toEqual({ backend: HUB });
  });
});

describe("GET /api/local/ready", () => {
  it("returns the same bootId every call", async () => {
    const a = await readyGet(ready()).json();
    const b = await readyGet(ready()).json();
    expect(a.bootId).toBeTruthy();
    expect(a.backend).toBe("github");
    process.env.MERGEPORT_BACKEND = HUB;
    expect((await readyGet(ready()).json()).backend).toBe(HUB);
    delete process.env.MERGEPORT_BACKEND;
    expect(b.bootId).toBe(a.bootId);
  });
});

describe("POST /api/local/switch", () => {
  it("refuses a Host that is not this loopback server even when Origin matches it (DNS rebinding)", async () => {
    for (const host of ["evil.example", "evil.example:3000", "127.0.0.1:3001"]) {
      expect((await POST(post({ backend: "github" }, { host, origin: `http://${host}` }))).status).toBe(403);
      expect(readyGet(ready(host)).status).toBe(403);
    }
    expect(sw.requestSwitch).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request", async () => {
    expect((await POST(post({ backend: HUB }, { origin: "http://evil.example" }))).status).toBe(403);
    expect(sw.requestSwitch).not.toHaveBeenCalled();
  });
  it("refuses without a session", async () => {
    sess.session = null;
    expect((await POST(post({ backend: HUB }))).status).toBe(401);
  });
  it("rejects a bad backend with 400", async () => {
    for (const backend of ["nope", "hub-xyz", 5, undefined]) expect((await POST(post({ backend }))).status).toBe(400);
    expect(sw.requestSwitch).not.toHaveBeenCalled();
  });
  it("returns launchUrl, previousBootId and expectedBackend, and never touches active.json", async () => {
    writeActive(home, { host: "github.com", accountId: "7", backend: "github" });
    sw.requestSwitch.mockResolvedValue({ launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old" });
    const res = await POST(post({ backend: HUB }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ launchUrl: "http://127.0.0.1:3000/api/local/launch?token=z", previousBootId: "old", expectedBackend: HUB });
    expect(readActive(home)).toEqual({ host: "github.com", accountId: "7", backend: "github" });
  });
  it("answers 409 when the launcher refuses (busy, unavailable target, no launcher)", async () => {
    for (const msg of ["Another workspace switch is in progress", "That server has no profile for this account yet.", "Switching needs the launcher. Start Mergeport with npm run local."]) {
      sw.requestSwitch.mockRejectedValueOnce(new Error(msg));
      const res = await POST(post({ backend: HUB }));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(msg);
    }
    expect(readActive(home)).toBeNull();
  });
});

describe("resolveStartProfile", () => {
  it("uses the hub db when active.json matches the account and the db exists", () => {
    const f = profileDbPath(home, "github.com", 7n, HUB);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
    writeActive(home, { host: "github.com", accountId: "7", backend: HUB });
    expect(resolveStartProfile(home, "github.com", 7n)).toEqual({ dbFile: f, backend: HUB });
    expect(readActive(home)?.backend).toBe(HUB);
  });
  it("falls back to github and rewrites active.json when the hub db is missing", () => {
    writeActive(home, { host: "github.com", accountId: "7", backend: HUB });
    expect(resolveStartProfile(home, "github.com", 7n)).toEqual({ dbFile: profileDbPath(home, "github.com", 7n), backend: "github" });
    expect(readActive(home)?.backend).toBe("github");
  });
  it("ignores an active.json that belongs to another account", () => {
    writeActive(home, { host: "github.com", accountId: "8", backend: HUB });
    expect(resolveStartProfile(home, "github.com", 7n).backend).toBe("github");
  });
  it("defaults to github with no or corrupt active.json", () => {
    expect(resolveStartProfile(home, "github.com", 7n).backend).toBe("github");
    fs.writeFileSync(path.join(home, "active.json"), "{nope");
    expect(resolveStartProfile(home, "github.com", 7n).backend).toBe("github");
  });
  it("resolveSwitchTarget refuses a hub with no profile", () => {
    expect(() => resolveSwitchTarget(home, "github.com", 7n, HUB)).toThrow(/no profile/);
    expect(resolveSwitchTarget(home, "github.com", 7n, "github").dbFile).toBe(profileDbPath(home, "github.com", 7n));
  });
});

describe("hub profile identity", () => {
  it("a hub db opened by another gh account is a mismatch", async () => {
    const f = profileDbPath(home, "github.com", 7n, HUB);
    const db = createPrisma(f);
    await ensureLocalProfile(db, { id: 7n, login: "alice", name: null, avatarUrl: null, host: "github.com" });
    await expect(ensureLocalProfile(db, { id: 8n, login: "bram", name: null, avatarUrl: null, host: "github.com" })).rejects.toBeInstanceOf(AccountMismatchError);
    await db.$disconnect();
  });
});

describe("waitForReady", () => {
  it("polls until the app answers", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 3 ? Promise.reject(new Error("refused")) : new Response(JSON.stringify({ bootId: "b1" }))));
    expect(await waitForReady(1, new AbortController().signal, { fetch: f as unknown as typeof fetch, intervalMs: 1 })).toBe("b1");
  });
  it("times out and honours abort", async () => {
    const f = vi.fn(async () => Promise.reject(new Error("refused")));
    await expect(waitForReady(1, new AbortController().signal, { fetch: f as unknown as typeof fetch, intervalMs: 1, timeoutMs: 20 })).rejects.toThrow("did not start");
    const ac = new AbortController();
    ac.abort();
    await expect(waitForReady(1, ac.signal, { fetch: f as unknown as typeof fetch })).rejects.toThrow();
  });
});
