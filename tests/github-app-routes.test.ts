import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { hubBackendId } from "@/lib/local/backends";
import { httpHubAdmin } from "@/lib/hub/ports-impl";
import { HubTeamService } from "@/lib/team/hub-service";
import { rememberAppState, resetAppStates } from "@/lib/hub/github-app-state";
import { useConversionFetch } from "@/lib/hub/github-app-conversion";
import { FAKE_SESSION, startFakeHub, type FakeMember } from "./fake-hub";

const m = vi.hoisted(() => ({ backend: "github", svc: null as unknown, origin: null as string | null, viewer: true, nonce: "" }));
vi.mock("@/lib/auth/current", () => ({ getAuth: async () => (m.viewer ? { viewer: { login: "boss" } } : null) }));
vi.mock("@/lib/local/workspaces", () => ({ currentBackend: async () => m.backend }));
vi.mock("@/lib/local/runtime", () => ({ getHubTeamService: async () => ({ svc: m.svc, dbFile: "x.db", origin: m.origin }) }));

import { POST as start } from "@/app/api/local/hub/github-app/start/route";
import { GET as callback } from "@/app/api/local/hub/github-app/callback/route";

const PEM = "-----BEGIN RSA PRIVATE KEY-----PEM-VALUE-----END RSA PRIVATE KEY-----";
const CLIENT_SECRET = "CLIENT-SECRET-VALUE";
const WEBHOOK_SECRET = "w3bh00k".padEnd(40, "x");
const CODE = "abcdef0123456789abcd";

/** GitHub's side of the manifest flow. Every request it receives is recorded; the answer carries the private key and client secret. */
function fakeGithub(answer: () => Response = () => new Response(JSON.stringify({ id: 99, slug: "mergeport-fake-team-abcd", client_id: "Iv1.abc", client_secret: CLIENT_SECRET, pem: PEM, webhook_secret: WEBHOOK_SECRET }), { status: 201, headers: { "content-type": "application/json" } })) {
  const requests: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body ?? null, headers: Object.fromEntries(new Headers(init.headers)) });
    return answer();
  }) as unknown as typeof fetch;
  return { f, requests };
}

const hubs: { stop(): Promise<void> }[] = [];
let home: string;
const people: FakeMember[] = [{ githubId: "1", login: "boss", role: "OWNER" }, { githubId: "3", login: "mem", role: "MEMBER" }];

/** A fake hub and the hub team service pointed at it, acting as `actor`. */
async function hub(actor = "1") {
  const h = await startFakeHub({ members: people.map((p) => ({ ...p })), githubId: actor });
  hubs.push(h);
  m.backend = hubBackendId(h.origin);
  m.origin = h.origin;
  m.svc = new HubTeamService(httpHubAdmin(h.origin, async () => FAKE_SESSION), actor);
  return h;
}

const HOST = "127.0.0.1:3000";
const startReq = (body: unknown, headers: Record<string, string> = { origin: `http://${HOST}` }) =>
  new Request(`http://${HOST}/api/local/hub/github-app/start`, { method: "POST", headers: { host: HOST, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const cbReq = (q: Record<string, string>, headers: Record<string, string> = { cookie: `mp_gh_app=${m.nonce}` }) =>
  new Request(`http://${HOST}/api/local/hub/github-app/callback?${new URLSearchParams(q)}`, { headers: { host: HOST, ...headers } });
type StartAnswer = { actionUrl: string; manifest: { name: string; url: string; public: boolean; hook_attributes: { url: string }; redirect_url: string; default_permissions: Record<string, string>; default_events: string[] }; state: string };
const begin = async (body: unknown = { account: "personal", contents: false, teammates: true }) => {
  const r = await start(startReq(body));
  m.nonce = /mp_gh_app=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "";
  return (await r.json()) as StartAnswer;
};
/** The callback answers a page whose meta refresh goes to /team; this is where the browser lands. */
const landing = async (r: Response) => /http-equiv="refresh" content="0;url=([^"]+)"/.exec(await r.text())?.[1] ?? null;

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-ghapp-"));
  process.env.MERGEPORT_HOME = home;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  resetAppStates();
  m.viewer = true;
  logs = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
});
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.stop();
  useConversionFetch(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.MERGEPORT_HOME;
  delete process.env.DEMO_MODE;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("start", () => {
  it("builds the manifest with the hub's origin and this app's own port, and returns a state", async () => {
    const h = await hub();
    const a = await begin({ account: "personal", contents: true, teammates: false });
    expect(a.actionUrl).toBe(`https://github.com/settings/apps/new?state=${a.state}`);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.manifest.url).toBe(h.origin);
    expect(a.manifest.hook_attributes.url).toBe(`${h.origin}/webhooks/github`);
    expect(a.manifest.redirect_url).toBe("http://127.0.0.1:3000/api/local/hub/github-app/callback");
    expect(a.manifest.name).toMatch(/^Mergeport Fake Team [a-z]{4}$/);
    expect(a.manifest.public).toBe(false);
    expect(a.manifest.default_events).toContain("push");
    expect(a.manifest.default_permissions.contents).toBe("read");
  });

  it("uses the organisation address, and refuses a bad organisation name", async () => {
    await hub();
    expect((await begin({ account: "org", org: "my-co" })).actionUrl).toMatch(/^https:\/\/github\.com\/organizations\/my-co\/settings\/apps\/new\?state=/);
    for (const org of ["", "a/b", "../x", "x y", 5]) expect((await start(startReq({ account: "org", org }))).status).toBe(400);
    expect((await start(startReq({ account: "elsewhere" }))).status).toBe(400);
  });

  it("refuses a MEMBER with 403 and issues no state", async () => {
    await hub("3");
    const r = await start(startReq({ account: "personal" }));
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false });
  });

  it("refuses cross-origin requests, a Host that is not this loopback server, demo mode, and a missing session", async () => {
    const h = await hub();
    expect((await start(startReq({ account: "personal" }, { origin: "http://evil.example" }))).status).toBe(403);
    for (const host of ["evil.example", "evil.example:3000", "127.0.0.1:3001", "localhost"]) expect((await start(startReq({ account: "personal" }, { host, origin: `http://${host}` }))).status).toBe(403);
    m.viewer = false;
    expect((await start(startReq({ account: "personal" }))).status).toBe(401);
    m.viewer = true;
    process.env.DEMO_MODE = "true";
    resetEnvCache();
    expect((await start(startReq({ account: "personal" }))).status).toBe(403);
    expect(h.requests.length).toBe(0);
  });

  it("each state is its own: two starts, two different single-use states", async () => {
    await hub();
    const [a, b] = [await begin(), await begin()];
    expect(a.state).not.toBe(b.state);
  });
});

describe("callback", () => {
  it("rejects an unknown state, a missing code and a reused state without calling GitHub or the hub", async () => {
    const h = await hub();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    for (const q of [{ code: CODE, state: "never-issued" }, { code: CODE }, { state: "x" }, {}] as Record<string, string>[]) {
      const r = await callback(cbReq(q));
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('href="/team"');
    }
    const { state } = await begin();
    expect(await landing(await callback(cbReq({ code: CODE, state })))).toBe("/team?github-app=created");
    const callsAfterFirst = gh.requests.length;
    const again = await callback(cbReq({ code: CODE, state }));
    expect(again.status).toBe(400);
    expect(gh.requests.length).toBe(callsAfterFirst);
    expect(h.requests.filter((r) => r.path === "/admin/github-webhook")).toHaveLength(1);
  });

  it("rejects an expired state (15 minutes) without calling GitHub", async () => {
    await hub();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    const { state } = await begin();
    vi.setSystemTime(new Date("2026-10-30T10:15:01Z"));
    expect((await callback(cbReq({ code: CODE, state }))).status).toBe(400);
    expect(gh.requests).toHaveLength(0);
  });

  it("refuses a Host that is not this loopback server before looking at the state", async () => {
    await hub();
    const { state } = await begin();
    for (const host of ["evil.example", "127.0.0.1:3001"]) expect((await callback(cbReq({ code: CODE, state }, { host, cookie: `mp_gh_app=${m.nonce}` }))).status).toBe(403);
    // the state was not spent by the refused requests
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    expect(await landing(await callback(cbReq({ code: CODE, state })))).toBe("/team?github-app=created");
  });

  it("works without an Origin header or a cookie, as a navigation from github.com does", async () => {
    await hub();
    useConversionFetch(fakeGithub().f);
    const { state } = await begin();
    const r = await callback(cbReq({ code: CODE, state }, { cookie: `mp_gh_app=${m.nonce}`, "sec-fetch-site": "cross-site", referer: "https://github.com/" }));
    expect(r.status).toBe(200);
    expect(await landing(r)).toBe("/team?github-app=created");
  });

  it("converts the code and sends only the secret and the slug to the hub; the key and client secret appear nowhere", async () => {
    const h = await hub();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    const { state } = await begin();
    const r = await callback(cbReq({ code: CODE, state }));
    const page = await r.clone().text();
    expect(await landing(r)).toBe("/team?github-app=created");

    // GitHub received exactly one call: the conversion, with no credential
    expect(gh.requests).toHaveLength(1);
    expect(gh.requests[0]).toMatchObject({ url: `https://api.github.com/app-manifests/${CODE}/conversions`, method: "POST" });
    expect(gh.requests[0].headers.authorization).toBeUndefined();

    // the hub got the secret and the slug, and nothing else
    const puts = h.requests.filter((x) => x.method === "PUT");
    expect(puts).toEqual([{ method: "PUT", path: "/admin/github-webhook", body: { secret: WEBHOOK_SECRET, appSlug: "mergeport-fake-team-abcd" } }]);
    expect(h.webhook).toMatchObject({ secret: WEBHOOK_SECRET, appSlug: "mergeport-fake-team-abcd" });

    // no private key or client secret in any outgoing request, any log line, or the page and headers the browser sees
    const outgoing = JSON.stringify([gh.requests, h.requests]);
    const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    const seen = page + JSON.stringify([...r.headers]);
    for (const secret of [PEM, "PEM-VALUE", CLIENT_SECRET, "Iv1.abc"]) {
      expect(outgoing).not.toContain(secret);
      expect(logged).not.toContain(secret);
      expect(seen).not.toContain(secret);
    }
    // the webhook secret itself is on the hub only: not in a URL, a log line or the page
    expect(page).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify([...r.headers])).not.toContain(WEBHOOK_SECRET);
    expect(logged).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(gh.requests)).not.toContain(WEBHOOK_SECRET);
  });

  it("a conversion failure goes to github-app=failed with a short reason and leaves the hub untouched", async () => {
    const h = await hub();
    useConversionFetch(fakeGithub(() => new Response(JSON.stringify({ message: "Not Found", pem: PEM }), { status: 404 })).f);
    const { state } = await begin();
    const r = await callback(cbReq({ code: CODE, state }));
    const page = await r.clone().text();
    expect(await landing(r)).toBe("/team?github-app=failed&reason=refused");
    expect(h.requests.some((x) => x.path === "/admin/github-webhook")).toBe(false);
    expect(h.webhook.secret).toBeNull();
    expect(page).not.toContain(PEM);
  });

  it("a network failure and an unusable answer fail the same way", async () => {
    const h = await hub();
    useConversionFetch((async () => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch);
    expect(await landing(await callback(cbReq({ code: CODE, state: (await begin()).state })))).toBe("/team?github-app=failed&reason=network");
    useConversionFetch(fakeGithub(() => new Response("<html>", { status: 201 })).f);
    expect(await landing(await callback(cbReq({ code: CODE, state: (await begin()).state })))).toBe("/team?github-app=failed&reason=bad-answer");
    expect(h.webhook.secret).toBeNull();
  });

  it("sets an HttpOnly, SameSite=Lax nonce cookie scoped to the github-app routes for 15 minutes", async () => {
    await hub();
    const r = await start(startReq({ account: "personal" }));
    const c = r.headers.get("set-cookie") ?? "";
    expect(c).toMatch(/^mp_gh_app=[A-Za-z0-9_-]{43};/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=lax/i);
    expect(c).toContain("Path=/api/local/hub/github-app/");
    expect(c).toMatch(/Max-Age=900/i);
    expect(c).not.toContain((await r.json()).state);
  });

  it("a missing or wrong nonce cookie answers the unknown-state page, consumes the state and calls nothing", async () => {
    const h = await hub();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    for (const cookie of [undefined, "mp_gh_app=wrong", "other=1", `mp_gh_app=${"x".repeat(43)}`]) {
      const { state } = await begin();
      const good = m.nonce;
      const r = await callback(cbReq({ code: CODE, state }, cookie ? { cookie } : {}));
      expect(r.status).toBe(400);
      expect(await r.text()).toContain('href="/team"');
      // the state is spent: even the right cookie no longer works
      expect((await callback(cbReq({ code: CODE, state }, { cookie: `mp_gh_app=${good}` }))).status).toBe(400);
    }
    expect(gh.requests).toHaveLength(0);
    expect(h.requests.some((x) => x.path === "/admin/github-webhook")).toBe(false);
  });

  it("a different member (the hub's owner changed, or a demotion) is refused before GitHub is called", async () => {
    const h = await hub();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    const { state } = await begin();
    // same hub, but the current owner is now someone else
    const real = httpHubAdmin(h.origin, async () => FAKE_SESSION);
    m.svc = new HubTeamService({ ...real, me: async () => { const r = await real.me(); return { ...r, member: { ...r.member, githubId: "9" } }; } }, "9");
    const r = await callback(cbReq({ code: CODE, state }));
    expect(r.status).toBe(400);
    expect(gh.requests).toHaveLength(0);
    expect(h.webhook.secret).toBeNull();
  });

  it("a person demoted after starting is refused before GitHub is called", async () => {
    const h = await hub("3");
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    const state = rememberAppState(h.origin, "1", "n0nce");
    expect((await callback(cbReq({ code: CODE, state }, { cookie: "mp_gh_app=n0nce" }))).status).toBe(400);
    expect(gh.requests).toHaveLength(0);
    expect(h.webhook.secret).toBeNull();
  });

  it("a state started for another hub is not honoured for this one", async () => {
    await hub();
    const { state } = await begin();
    const gh = fakeGithub();
    useConversionFetch(gh.f);
    m.origin = "https://another-hub.example.com";
    expect(await landing(await callback(cbReq({ code: CODE, state })))).toBe("/team?github-app=failed&reason=hub");
    expect(gh.requests).toHaveLength(0);
  });
});
