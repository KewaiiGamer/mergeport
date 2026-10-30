import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";
import { HubAuth, completeConnect, safeVerificationUri } from "@/lib/hub/connect";
import { hubLinkStatus, hubSessionPort } from "@/lib/hub/ports-impl";
import { hubBackendId } from "@/lib/local/backends";
import { profileDbPath } from "@/lib/local/profile";
import { readActive, readHubs } from "@/lib/local/registry";
import type { GhStatus } from "@/lib/github/gh";
import { FAKE_DEVICE_CODE, FAKE_POLL_SECRET, startFakeHub } from "./fake-hub";

const hubs: { stop(): Promise<void> }[] = [];
const dirs: string[] = [];
const hub = async (o: Parameters<typeof startFakeHub>[0] = {}) => {
  const h = await startFakeHub(o);
  hubs.push(h);
  return h;
};
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mp-hubconn-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const ghOk = (id: bigint): GhStatus => ({ state: "ok", identity: { id, login: "octocat", name: null, avatarUrl: null, host: "github.com" } });

describe("HubAuth.health", () => {
  it("returns the team name and canonical origin", async () => {
    const h = await hub();
    const typed = h.origin.replace("http://", "HTTP://") + "/";
    const r = await new HubAuth().health(typed, "github.com");
    expect(r.origin).toBe(h.origin);
    expect(r.teamName).toBe("Fake Team");
    expect(r.backend).toBe(hubBackendId(h.origin));
  });
  it("rejects a publicUrl that differs from what was typed, naming both", async () => {
    const h = await hub({ publicUrl: "https://elsewhere.example.com" });
    await expect(new HubAuth().health(h.origin, "github.com")).rejects.toThrow(/https:\/\/elsewhere\.example\.com.*127\.0\.0\.1/);
  });
  it("rejects a different GitHub host", async () => {
    const h = await hub({ githubHost: "ghe.example.com" });
    await expect(new HubAuth().health(h.origin, "github.com")).rejects.toThrow(/ghe\.example\.com/);
  });
  it("rejects ok:false and a closed port", async () => {
    const stopped = await startFakeHub();
    const origin = stopped.origin;
    await stopped.stop();
    await expect(new HubAuth().health(origin, "github.com")).rejects.toThrow(/reach/i);
    const bad = new HubAuth((async () => new Response(JSON.stringify({ ok: false }), { status: 200 })) as typeof fetch);
    await expect(bad.health("http://127.0.0.1:9", "github.com")).rejects.toThrow();
  });
  it("rejects plain http off loopback before any request", async () => {
    const h = await hub();
    await expect(new HubAuth().health("http://example.com", "github.com")).rejects.toThrow();
    expect(h.requests.length).toBe(0);
  });
});

describe("HubAuth device flow", () => {
  it("start returns the user code", async () => {
    const h = await hub();
    const s = await new HubAuth().start(h.origin);
    expect(s.userCode).toBe("ABCD-1234");
    expect(s.deviceCode).toBe(FAKE_DEVICE_CODE);
    expect(s.pollSecret).toBe(FAKE_POLL_SECRET);
  });
  it("polls pending twice then ok, sending the device code with its poll secret", async () => {
    const h = await hub({ pollsBeforeOk: 2, githubId: "7", login: "mona" });
    const a = new HubAuth();
    expect(await a.poll(h.origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "pending" });
    expect(await a.poll(h.origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "pending" });
    const ok = await a.poll(h.origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET);
    expect(ok).toMatchObject({ status: "ok", member: { githubId: "7", login: "mona" }, team: { name: "Fake Team" } });
    expect(h.requests.filter((r) => r.path === "/auth/device/poll").map((r) => r.body)).toEqual(Array(3).fill({ deviceCode: FAKE_DEVICE_CODE, pollSecret: FAKE_POLL_SECRET }));
  });
  it("passes slowDown on, and a wrong poll secret (404) reads as expired", async () => {
    const h = await hub({ slowDownPolls: 1, pollsBeforeOk: 1 });
    const a = new HubAuth();
    expect(await a.poll(h.origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "pending", slowDown: true });
    expect(await a.poll(h.origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "pending" });
    expect(await a.poll(h.origin, FAKE_DEVICE_CODE, "wrong")).toEqual({ status: "expired" });
  });
  it("maps refusals and expiry", async () => {
    const a = new HubAuth();
    expect(await a.poll((await hub({ invited: false })).origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "refused", reason: "not-invited" });
    expect(await a.poll((await hub({ removed: true })).origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "refused", reason: "removed" });
    expect(await a.poll((await hub({ expired: true })).origin, FAKE_DEVICE_CODE, FAKE_POLL_SECRET)).toEqual({ status: "expired" });
  });
});

describe("completeConnect", () => {
  const base = (h: string, origin: string, gh: GhStatus) => ({ home: h, host: "github.com", origin, teamName: "Fake Team", session: "session-token-secret", member: { githubId: "42", login: "octocat" }, gh, ports: { session: hubSessionPort } });

  it("creates the profile and hubs.json entry, leaves active.json to the launcher, and never writes the token", async () => {
    const h = home();
    const origin = "http://127.0.0.1:4000";
    const r = await completeConnect(base(h, origin, ghOk(42n)));
    const backend = hubBackendId(origin);
    expect(r).toEqual({ ok: true, backend });
    const db = profileDbPath(h, "github.com", 42n, backend);
    expect(db).toMatch(/github\.com-42-hub-[0-9a-f]{16}/);
    expect(fs.existsSync(db)).toBe(true);
    expect(readHubs(h)[0]).toMatchObject({ origin, teamName: "Fake Team", lastSignedInAs: { id: "42", login: "octocat" } });
    expect(readActive(h)).toBeNull(); // written by the launcher's onSwitched once the new workspace is up
    expect(fs.existsSync(path.join(h, "active.json"))).toBe(false);
    expect(fs.readFileSync(path.join(h, "hubs.json"), "utf8")).not.toContain("session-token-secret");
    for (const f of fs.readdirSync(path.dirname(db))) expect(fs.readFileSync(path.join(path.dirname(db), f))).not.toContain("session-token-secret");
    expect(await hubSessionPort.read(db)).toEqual({ origin, token: "session-token-secret", githubId: "42" });
    const prisma = createPrisma(db);
    try {
      expect(await prisma.teamConfig.findUnique({ where: { id: "team" } })).toMatchObject({ mode: "TEAM", backend: "HUB", hubOrigin: origin, name: "Fake Team" });
      expect(await prisma.hubSession.findUnique({ where: { id: "session" } })).toMatchObject({ origin, githubId: 42n, login: "octocat" });
    } finally {
      await prisma.$disconnect();
    }
    await hubSessionPort.remove(db);
    expect(await hubSessionPort.read(db)).toBeNull();
    expect(await hubLinkStatus(db)).toEqual({ state: "offline", pendingOps: 0, needsSignIn: false });
  });
  it("mismatch writes nothing", async () => {
    const h = home();
    expect(await completeConnect(base(h, "http://127.0.0.1:4000", ghOk(43n)))).toEqual({ ok: false, error: "mismatch" });
    expect(fs.readdirSync(h)).toEqual([]);
  });
  it("maps gh states", async () => {
    const h = home();
    expect(await completeConnect(base(h, "http://127.0.0.1:4000", { state: "not-logged-in" }))).toEqual({ ok: false, error: "gh-login" });
    expect(await completeConnect(base(h, "http://127.0.0.1:4000", { state: "missing-gh" }))).toEqual({ ok: false, error: "gh-missing" });
    expect(await completeConnect(base(h, "http://127.0.0.1:4000", { state: "error", message: "x" }))).toEqual({ ok: false, error: "gh-error" });
    expect(fs.readdirSync(h)).toEqual([]);
  });
});

describe("completeConnect hardening", () => {
  const base = (h: string, gh: GhStatus, githubId: string) => ({ home: h, host: "github.com", origin: "http://127.0.0.1:4000", teamName: "T", session: "s", member: { githubId, login: "octocat" }, gh, ports: { session: hubSessionPort } });
  it("non-numeric hub id is a mismatch, not a throw", async () => {
    const h = home();
    expect(await completeConnect(base(h, ghOk(42n), "not-a-number"))).toEqual({ ok: false, error: "mismatch" });
    expect(fs.readdirSync(h)).toEqual([]);
  });
  it("gh identity on another host is a mismatch", async () => {
    const h = home();
    const gh: GhStatus = { state: "ok", identity: { id: 42n, login: "octocat", name: null, avatarUrl: null, host: "ghe.example.com" } };
    expect(await completeConnect(base(h, gh, "42"))).toEqual({ ok: false, error: "mismatch" });
    expect(fs.readdirSync(h)).toEqual([]);
  });
});

describe("safeVerificationUri", () => {
  it("allows https github.com and the profile host only", () => {
    expect(safeVerificationUri("https://github.com/login/device", "github.com")).toBe("https://github.com/login/device");
    expect(safeVerificationUri("https://ghe.example.com/login/device", "ghe.example.com")).toBe("https://ghe.example.com/login/device");
    for (const bad of ["http://github.com/login/device", "https://evil.example/login/device", "https://github.com.evil.example/x", "javascript:alert(1)", "https://u:p@github.com/x", "nope", "https://github.com:8443/x", "https://ghe.example.com/x"]) expect(safeVerificationUri(bad, "github.com")).toBeNull();
  });
});
