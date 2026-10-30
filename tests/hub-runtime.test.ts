import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resolveDbFile } from "@/lib/db";
import { truncateAll } from "@/lib/demo/seed";
import { resetEnvCache } from "@/lib/env";
import { hubLinkStatus, hubSessionPort } from "@/lib/hub/ports-impl";
import { ensureLocalProfile } from "@/lib/local/profile";
import { getEngine, resetRuntime } from "@/lib/local/runtime";

/** getEngine() picks the backend from TeamConfig: a hub profile talks to the hub, a GitHub profile keeps the GitHub store. */

const ORIGIN = "http://127.0.0.1:1";
const TOKEN = "hub-session-token";
const calls: { url: string; auth: string | null }[] = [];

const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const h = new Headers(init?.headers);
  calls.push({ url, auth: h.get("authorization") });
  if (/\/entities\?since=0$/.test(url)) return new Response(JSON.stringify({ seq: "0", events: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 404 });
};

beforeEach(async () => {
  process.env.DEMO_MODE = "false";
  resetEnvCache();
  resetRuntime();
  calls.length = 0;
  vi.stubGlobal("fetch", fakeFetch);
  await truncateAll(db); // the shared test database may hold another file's local account; this profile must be the only one
  await ensureLocalProfile(db, { id: 4242n, login: "runtime-user", name: null, avatarUrl: null, host: "github.com" });
});
afterEach(async () => {
  resetRuntime();
  vi.unstubAllGlobals();
  await db.space.deleteMany({ where: { backend: "HUB" } });
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team" }, update: { mode: "PERSONAL", backend: "GITHUB", hubOrigin: null } });
  await hubSessionPort.remove(resolveDbFile());
  process.env.DEMO_MODE = "true";
  resetEnvCache();
});

const hubSpace = () => db.space.create({ data: { remoteId: "common", teamRemoteId: "t", kind: "COMMON", name: "Workspace", repoOwner: "", repoName: "", backend: "HUB", hubSpaceId: "common", canWrite: true } });

describe("runtime engine per backend", () => {
  it("a hub profile gets an engine whose pull calls the hub with the vault token", async () => {
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN }, update: { mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN } });
    await hubSessionPort.save(resolveDbFile(), { origin: ORIGIN, token: TOKEN, githubId: "4242", login: "runtime-user" });
    const space = await hubSpace();
    const engine = await getEngine();
    expect(engine).not.toBeNull();
    expect(await getEngine()).toBe(engine);
    await engine!.pullSpace(space);
    const pull = calls.find((c) => c.url.includes("/spaces/common/entities"));
    expect(pull).toBeDefined();
    expect(pull!.url.startsWith(ORIGIN)).toBe(true);
    expect(pull!.auth).toBe(`Bearer ${TOKEN}`);
    // the live link exists for this profile: its state is reported (not live yet: nothing listens on port 1)
    const status = await hubLinkStatus(resolveDbFile());
    expect(["reconnecting", "offline"]).toContain(status.state);
    expect(status.pendingOps).toBe(0);
  });

  it("concurrent first callers share one engine, so the live link and the pages drive the same one", async () => {
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN }, update: { mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN } });
    await hubSessionPort.save(resolveDbFile(), { origin: ORIGIN, token: TOKEN, githubId: "4242", login: "runtime-user" });
    const engines = await Promise.all([getEngine(), getEngine(), getEngine(), getEngine()]);
    expect(engines[0]).not.toBeNull();
    for (const e of engines) expect(e).toBe(engines[0]);
    expect(await getEngine()).toBe(engines[0]);
  });

  it("a GitHub profile keeps the GitHub store and has no hub client", async () => {
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "GITHUB" }, update: { mode: "TEAM", backend: "GITHUB", hubOrigin: null } });
    const space = await hubSpace();
    const engine = await getEngine();
    expect(engine).not.toBeNull();
    await expect(engine!.pullSpace(space)).rejects.toThrow("No hub client configured");
    expect(calls).toHaveLength(0);
  });

  it("a hub profile without a session reports needsSignIn", async () => {
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN }, update: { mode: "TEAM", backend: "HUB", hubOrigin: ORIGIN } });
    await getEngine();
    await vi.waitFor(async () => expect((await hubLinkStatus(resolveDbFile())).needsSignIn).toBe(true), { timeout: 2000 });
  });
});
