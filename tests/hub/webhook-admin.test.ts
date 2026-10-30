import { afterEach, describe, expect, it } from "vitest";
import { deliver, signInAs, startTestHub, type TestHub } from "./harness";

const SECRET = "s".repeat(20) + "A1b2C3d4E5f6G7h8I9j0";
const ENV_SECRET = "e".repeat(20) + "Z9y8X7w6V5u4T3s2R1q0";
const ping = { zen: "Keep it logically awesome." };

let hub: TestHub;
afterEach(async () => {
  await hub.close();
});

async function start(o: Parameters<typeof startTestHub>[0] = {}) {
  hub = await startTestHub(o);
  const owner = await signInAs(hub, 1n, "olive");
  const api = hub.api(owner);
  const addMember = async (id: bigint, login: string, role: string) => {
    hub.github.addUser({ id, login });
    expect((await api("POST", "/admin/invites", { githubLogin: login, role })).status).toBe(201);
    return signInAs(hub, id, login);
  };
  return { owner, api, addMember };
}

describe("PUT /admin/github-webhook", () => {
  it("OWNER stores the secret; signatures made with it then verify", async () => {
    const { api } = await start();
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(404);
    const put = await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "mergeport-acme-abcd" });
    expect(put.status).toBe(204);
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(200);
    expect((await deliver(hub, "x".repeat(40), "ping", ping)).status).toBe(401);
    // The secret is stored in the settings table, not anywhere a route returns it.
    expect(hub.db.prepare("SELECT value FROM setting WHERE key = 'github_webhook_secret'").get()).toEqual({ value: SECRET });
    expect(hub.db.prepare("SELECT value FROM setting WHERE key = 'github_app_slug'").get()).toEqual({ value: "mergeport-acme-abcd" });
  });

  it("is refused for ADMIN and MEMBER (403) and without a session (401)", async () => {
    const { api, addMember } = await start();
    const admin = await addMember(2n, "adam", "ADMIN");
    const member = await addMember(3n, "mia", "MEMBER");
    expect((await hub.api(admin)("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(403);
    expect((await hub.api(member)("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(403);
    expect((await hub.api()("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(401);
    expect((await hub.api("not-a-session")("PUT", "/admin/github-webhook", { secret: SECRET })).status).toBe(401);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM setting").get()).toEqual({ n: 0 });
    expect((await hub.api(admin)("DELETE", "/admin/github-webhook")).status).toBe(403);
    expect((await hub.api()("DELETE", "/admin/github-webhook")).status).toBe(401);
    expect((await api("GET", "/me")).body.webhooks.enabled).toBe(false);
  });

  it("rejects a secret under 32 or over 256 characters, a missing secret and a bad slug (400)", async () => {
    const { api } = await start();
    expect((await api("PUT", "/admin/github-webhook", { secret: "x".repeat(31) })).status).toBe(400);
    expect((await api("PUT", "/admin/github-webhook", { secret: "x".repeat(257) })).status).toBe(400);
    expect((await api("PUT", "/admin/github-webhook", {})).status).toBe(400);
    expect((await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "bad slug!" })).status).toBe(400);
    expect((await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "a".repeat(101) })).status).toBe(400);
    expect((await api("PUT", "/admin/github-webhook", { secret: "x".repeat(32) })).status).toBe(204);
    expect((await api("PUT", "/admin/github-webhook", { secret: "x".repeat(256) })).status).toBe(204);
  });

  it("replaces a previous secret and drops a previous slug when none is given", async () => {
    const { api } = await start();
    await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "first" });
    await api("PUT", "/admin/github-webhook", { secret: ENV_SECRET });
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(401);
    expect((await deliver(hub, ENV_SECRET, "ping", ping)).status).toBe(200);
    expect((await api("GET", "/me")).body.webhooks.appSlug).toBeNull();
  });

  it("survives a restart on the same data directory", async () => {
    const { api } = await start();
    await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "kept" });
    const dataDir = hub.dataDir;
    await hub.close();
    hub = await startTestHub({ dataDir });
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(200);
  });
});

describe("DELETE /admin/github-webhook", () => {
  it("returns the endpoint to 404 and clears the slug", async () => {
    const { api } = await start();
    await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "gone" });
    expect((await api("DELETE", "/admin/github-webhook")).status).toBe(204);
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(404);
    expect(hub.db.prepare("SELECT COUNT(*) AS n FROM setting").get()).toEqual({ n: 0 });
    const me = (await api("GET", "/me")).body;
    expect(me.webhooks.enabled).toBe(false);
    expect(me.webhooks.appSlug).toBeNull();
    // Deleting again is fine.
    expect((await api("DELETE", "/admin/github-webhook")).status).toBe(204);
  });
});

describe("environment fallback", () => {
  it("is used when the table holds no secret, and the table wins once it has one", async () => {
    const { api } = await start({ webhookSecretEnv: ENV_SECRET });
    expect((await api("GET", "/me")).body.webhooks.enabled).toBe(true);
    expect((await deliver(hub, ENV_SECRET, "ping", ping)).status).toBe(200);
    await api("PUT", "/admin/github-webhook", { secret: SECRET });
    expect((await deliver(hub, ENV_SECRET, "ping", ping)).status).toBe(401);
    expect((await deliver(hub, SECRET, "ping", ping)).status).toBe(200);
    await api("DELETE", "/admin/github-webhook");
    // Removing the table value falls back to the environment, which the owner cannot change from the app.
    expect((await deliver(hub, ENV_SECRET, "ping", ping)).status).toBe(200);
  });

  it("config rejects a fallback secret outside 32 to 256 characters", async () => {
    const { loadConfig } = await import("../../hub/src/config");
    const base = { MERGEPORT_HUB_DATA: "d", MERGEPORT_HUB_PUBLIC_URL: "https://h.example.com", MERGEPORT_HUB_GITHUB_CLIENT_ID: "i", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "s", MERGEPORT_HUB_OWNER_LOGIN: "olive" };
    expect(loadConfig({ ...base, MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET: ENV_SECRET }).githubWebhookSecret).toBe(ENV_SECRET);
    expect(loadConfig(base).githubWebhookSecret).toBeUndefined();
    expect(() => loadConfig({ ...base, MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET: "short" })).toThrow(/MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET/);
    hub = await startTestHub();
  });
});

describe("GET /me webhooks", () => {
  it("reflects state: off, configured, last delivery", async () => {
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const { api } = await start({ now: () => clock });
    expect((await api("GET", "/me")).body.webhooks).toEqual({ enabled: false, appSlug: null, lastDeliveryAt: null, lastEvent: null });
    await api("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "mergeport-x" });
    expect((await api("GET", "/me")).body.webhooks).toEqual({ enabled: true, appSlug: "mergeport-x", lastDeliveryAt: null, lastEvent: null });
    clock += 5000;
    await deliver(hub, SECRET, "ping", ping);
    expect((await api("GET", "/me")).body.webhooks).toEqual({ enabled: true, appSlug: "mergeport-x", lastDeliveryAt: "2026-11-01T10:00:05.000Z", lastEvent: "ping" });
    clock += 5000;
    await deliver(hub, SECRET, "issues", { repository: { id: 1, private: false, owner: { login: "o" } } });
    expect((await api("GET", "/me")).body.webhooks).toMatchObject({ lastDeliveryAt: "2026-11-01T10:00:10.000Z", lastEvent: "issues" });
  });

  it("a rejected delivery does not change the status; /health is unchanged", async () => {
    const { api } = await start();
    await api("PUT", "/admin/github-webhook", { secret: SECRET });
    await deliver(hub, SECRET, "ping", ping, { signature: "sha256=" + "0".repeat(64) });
    expect((await api("GET", "/me")).body.webhooks.lastDeliveryAt).toBeNull();
    const health = (await hub.api()("GET", "/health")).body;
    expect(Object.keys(health).sort()).toEqual(["bootstrapped", "githubHost", "ok", "publicUrl", "schema", "team"]);
  });
});

describe("secret hygiene", () => {
  it("the secret appears in no response and no log line", async () => {
    const { api } = await start();
    const texts: string[] = [];
    const grab = async (method: string, p: string, body?: unknown) => {
      const r = await api(method, p, body);
      texts.push(JSON.stringify(r.body), JSON.stringify([...r.headers.entries()]));
    };
    await grab("PUT", "/admin/github-webhook", { secret: SECRET, appSlug: "s" });
    await grab("GET", "/me");
    await grab("GET", "/admin/members");
    await grab("GET", "/admin/spaces");
    await grab("GET", "/health");
    for (const sig of [undefined, null, "sha256=" + "1".repeat(64)] as const) {
      const r = await deliver(hub, SECRET, "ping", ping, { signature: sig });
      texts.push(JSON.stringify(r.body), JSON.stringify([...r.headers.entries()]));
    }
    await grab("DELETE", "/admin/github-webhook");
    for (const t of texts) expect(t).not.toContain(SECRET);
    for (const l of hub.logs) expect(l).not.toContain(SECRET);
    expect(hub.logs.length).toBeGreaterThan(0);
  });
});
