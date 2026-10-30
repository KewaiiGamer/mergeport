import { describe, expect, it } from "vitest";
import { buildManifest, manifestActionUrl } from "@/lib/hub/github-app-manifest";
import { APP_STATE_TTL_MS, consumeAppState, rememberAppState, resetAppStates } from "@/lib/hub/github-app-state";
import { ConversionError, convertManifest } from "@/lib/hub/github-app-conversion";
import { addTrackedRepositories, installUrl } from "@/lib/hub/github-app-install";
import { GitHubRest } from "@/lib/github/rest";
import { appFailureText, byHandValues, generateSecret, webhookStatus } from "@/lib/hub/webhook-panel";

const letters = () => "abcd";
const base = { teamName: "Fake Team", hubOrigin: "https://hub.example.com/", port: 3456, teammates: true, contents: false, randomLetters: letters };

describe("manifest builder", () => {
  it("uses the hub origin, this app's port, the read-only permissions and the base events", () => {
    const m = buildManifest(base);
    expect(m).toEqual({
      name: "Mergeport Fake Team abcd",
      url: "https://hub.example.com",
      hook_attributes: { url: "https://hub.example.com/webhooks/github", active: true },
      redirect_url: "http://127.0.0.1:3456/api/local/hub/github-app/callback",
      public: true,
      request_oauth_on_install: false,
      default_permissions: { issues: "read", pull_requests: "read", checks: "read", statuses: "read", metadata: "read" },
      default_events: ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_run", "check_suite", "status"],
    });
  });

  it("public follows teammates; contents adds the permission and the push, create, delete events", () => {
    expect(buildManifest({ ...base, teammates: false }).public).toBe(false);
    const m = buildManifest({ ...base, contents: true });
    expect(m.default_permissions).toMatchObject({ contents: "read", issues: "read" });
    expect(m.default_events.slice(-3)).toEqual(["push", "create", "delete"]);
    expect(buildManifest(base).default_permissions).not.toHaveProperty("contents");
  });

  it("adds four random lowercase letters by default", () => {
    const { randomLetters: _r, ...rest } = base;
    expect(buildManifest(rest).name).toMatch(/^Mergeport Fake Team [a-z]{4}$/);
  });

  it("builds the personal and organisation action URLs with the state", () => {
    expect(manifestActionUrl({ kind: "personal" }, "st_1-x")).toBe("https://github.com/settings/apps/new?state=st_1-x");
    expect(manifestActionUrl({ kind: "org", org: "my-co" }, "st")).toBe("https://github.com/organizations/my-co/settings/apps/new?state=st");
  });
});

describe("single-use state", () => {
  it("is 32 random bytes (base64url), works once, and remembers the hub origin", () => {
    resetAppStates();
    const s = rememberAppState("https://h.example", "1", "n");
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(consumeAppState(s)).toMatchObject({ hubOrigin: "https://h.example", memberId: "1", nonce: "n" });
    expect(consumeAppState(s)).toBeNull();
    expect(consumeAppState("never-issued")).toBeNull();
  });

  it("expires after 15 minutes on the injected clock, and an expired state is gone for good", () => {
    resetAppStates();
    let t = 1_000_000;
    const clock = () => t;
    const a = rememberAppState("https://h.example", "1", "n", clock);
    const b = rememberAppState("https://h.example", "1", "n", clock);
    t += APP_STATE_TTL_MS - 1;
    expect(consumeAppState(a, clock)).not.toBeNull();
    t += 1;
    expect(consumeAppState(b, clock)).toBeNull();
    t -= 5;
    expect(consumeAppState(b, clock)).toBeNull();
    expect(APP_STATE_TTL_MS).toBe(15 * 60_000);
  });
});

const CONVERSION = { id: 7, slug: "mergeport-fake-team-abcd", client_id: "Iv1.client", client_secret: "CLIENT-SECRET-VALUE", pem: "-----BEGIN RSA PRIVATE KEY-----PEM-VALUE", webhook_secret: "w".repeat(40) };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("manifest conversion", () => {
  it("posts to the conversions URL with no credential and returns only the secret and the slug", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (seen.push({ url, init }), json(201, CONVERSION))) as unknown as typeof fetch;
    const r = await convertManifest("abcdef0123456789abcd", f);
    expect(r).toEqual({ secret: "w".repeat(40), slug: "mergeport-fake-team-abcd" });
    expect(Object.keys(r).sort()).toEqual(["secret", "slug"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.github.com/app-manifests/abcdef0123456789abcd/conversions");
    expect(seen[0].init.method).toBe("POST");
    expect(Object.keys(seen[0].init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a code that could change the path", "../../user", async () => json(201, CONVERSION), "bad-code"],
    ["a refusal", "abcdef0123456789abcd", async () => json(404, { message: "Not Found" }), "refused"],
    ["a network failure", "abcdef0123456789abcd", async () => Promise.reject(new TypeError("down")), "network"],
    ["an answer without a secret", "abcdef0123456789abcd", async () => json(201, { slug: "x" }), "bad-answer"],
    ["a too short secret", "abcdef0123456789abcd", async () => json(201, { ...CONVERSION, webhook_secret: "short" }), "bad-answer"],
    ["a slug that is not a slug", "abcdef0123456789abcd", async () => json(201, { ...CONVERSION, slug: "a/b" }), "bad-answer"],
  ])("fails on %s without carrying any answer text", async (_n, code, answer, reason) => {
    const err = await convertManifest(code, answer as unknown as typeof fetch).catch((e) => e);
    expect(err).toBeInstanceOf(ConversionError);
    expect(err.reason).toBe(reason);
    expect(JSON.stringify(err) + err.message).not.toMatch(/PEM-VALUE|CLIENT-SECRET-VALUE/);
  });
});

/** GitHub on a map: installations, their repositories, and which PUTs are refused. */
function fakeGithub(o: { installations: { id: number; app_slug: string; account: string }[]; repos: Record<number, number[]>; put?: Record<string, number>; listStatus?: number; repoListStatus?: number; rateLimited?: string[] }) {
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (method === "GET" && u.pathname === "/user/installations") {
      if (o.listStatus) return json(o.listStatus, { message: "no" });
      return json(200, { total_count: o.installations.length, installations: o.installations.map((i) => ({ id: i.id, app_slug: i.app_slug, repository_selection: "selected", account: { login: i.account } })) });
    }
    const list = /^\/user\/installations\/(\d+)\/repositories$/.exec(u.pathname);
    if (method === "GET" && list && o.repoListStatus) return json(o.repoListStatus, { message: "no" });
    if (method === "GET" && list) return json(200, { total_count: 0, repositories: (o.repos[Number(list[1])] ?? []).map((id) => ({ id })) });
    const put = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(u.pathname);
    if (method === "PUT" && put) {
      if (o.rateLimited?.includes(put[2])) return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "retry-after": "30" } });
      const status = o.put?.[put[2]] ?? 204;
      return status === 204 ? new Response(null, { status }) : json(status, { message: "refused" });
    }
    return json(404, { message: "unexpected" });
  }) as unknown as typeof fetch;
  return { rest: new GitHubRest(f), calls };
}
const tracked = [
  { githubId: "11", fullName: "acme/one" },
  { githubId: "12", fullName: "acme/two" },
  { githubId: "13", fullName: "acme/three" },
  { githubId: "14", fullName: "other/four" },
];

describe("installation helper", () => {
  it("filters installations by app_slug, adds only uncovered tracked repositories, one request each", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }, { id: 2, app_slug: "another-app", account: "acme" }], repos: { 1: [11], 2: [12] } });
    const r = await addTrackedRepositories(gh.rest, "team-app", tracked.slice(0, 3));
    expect(r.state).toBe("checked");
    expect(r.added).toEqual(["acme/two", "acme/three"]);
    expect(r.failed).toEqual([]);
    expect(r.covered.sort()).toEqual(["11", "12", "13"]);
    expect(gh.calls).toEqual(["GET /user/installations", "GET /user/installations/1/repositories", "PUT /user/installations/1/repositories/12", "PUT /user/installations/1/repositories/13"]);
  });

  it("sends nothing but the two reads when everything is covered", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: { 1: [11, 12, 13] } });
    const r = await addTrackedRepositories(gh.rest, "team-app", tracked.slice(0, 3));
    expect(r.added).toEqual([]);
    expect(gh.calls.some((c) => c.startsWith("PUT"))).toBe(false);
  });

  it("reports 403 and 404 per repository and keeps going; one failure does not hide the rest", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: { 1: [] }, put: { "11": 403, "12": 404 } });
    const r = await addTrackedRepositories(gh.rest, "team-app", tracked.slice(0, 3));
    expect(r.failed).toEqual([{ fullName: "acme/one", status: 403, reason: "install-on-github" }, { fullName: "acme/two", status: 404, reason: "install-on-github" }]);
    expect(r.added).toEqual(["acme/three"]);
    expect(r.covered).toEqual(["13"]);
  });

  it("a rate limit (a 403 too) stops the loop: that repository and the rest are try-again-later, nothing is called after it, earlier adds are kept", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: { 1: [] }, rateLimited: ["12"] });
    const r = await addTrackedRepositories(gh.rest, "team-app", tracked.slice(0, 3));
    expect(r.added).toEqual(["acme/one"]);
    expect(r.covered).toEqual(["11"]);
    expect(r.failed).toEqual([{ fullName: "acme/two", status: null, reason: "try-again-later" }, { fullName: "acme/three", status: null, reason: "try-again-later" }]);
    expect(gh.calls.filter((c) => c.startsWith("PUT"))).toEqual(["PUT /user/installations/1/repositories/11", "PUT /user/installations/1/repositories/12"]);
  });

  it("any other error is recorded for that repository only and the loop continues", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: { 1: [] }, put: { "11": 500, "12": 422 } });
    const r = await addTrackedRepositories(gh.rest, "team-app", tracked.slice(0, 3));
    expect(r.failed).toEqual([{ fullName: "acme/one", status: null, reason: "failed" }, { fullName: "acme/two", status: null, reason: "failed" }]);
    expect(r.added).toEqual(["acme/three"]);
  });

  it("a refusal while listing an installation's repositories is cannot-list, like the installations list", async () => {
    for (const repoListStatus of [403, 404]) {
      const r = await addTrackedRepositories(fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: {}, repoListStatus }).rest, "team-app", tracked);
      expect(r).toMatchObject({ state: "cannot-list", added: [], covered: [] });
    }
  });

  it("does not ask for a repository whose owner has no installation of the App; it reports it", async () => {
    const gh = fakeGithub({ installations: [{ id: 1, app_slug: "team-app", account: "acme" }], repos: { 1: [11] } });
    const r = await addTrackedRepositories(gh.rest, "team-app", [tracked[0], tracked[3]]);
    expect(r.failed).toEqual([{ fullName: "other/four", status: null, reason: "install-on-github" }]);
    expect(gh.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });

  it("says so when the App is not installed, and when GitHub will not list installations", async () => {
    const none = await addTrackedRepositories(fakeGithub({ installations: [{ id: 2, app_slug: "another-app", account: "acme" }], repos: {} }).rest, "team-app", tracked);
    expect(none).toMatchObject({ state: "not-installed", added: [], covered: [], installUrl: "https://github.com/apps/team-app/installations/new" });
    const refused = await addTrackedRepositories(fakeGithub({ installations: [], repos: {}, listStatus: 403 }).rest, "team-app", tracked);
    expect(refused.state).toBe("cannot-list");
    expect(installUrl("team-app")).toBe("https://github.com/apps/team-app/installations/new");
  });
});

describe("panel words and values", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const w = (o: Partial<Parameters<typeof webhookStatus>[0]>) => ({ enabled: true, appSlug: "a", lastDeliveryAt: null, lastEvent: null, ...o });

  it("has the three spec texts, plus one for a quiet day", () => {
    expect(webhookStatus(w({ enabled: false }), now)).toEqual({ kind: "off", text: "Not set up" });
    expect(webhookStatus(w({}), now)).toEqual({ kind: "waiting", text: "Waiting for the first event from GitHub" });
    expect(webhookStatus(w({ lastDeliveryAt: "2026-10-30T11:59:00Z" }), now)).toEqual({ kind: "on", text: "Instant GitHub updates are on" });
    expect(webhookStatus(w({ lastDeliveryAt: "2026-10-29T12:00:01Z" }), now).kind).toBe("on");
    expect(webhookStatus(w({ lastDeliveryAt: "2026-10-29T11:59:59Z" }), now).kind).toBe("quiet");
  });

  it("generates a 64-hex-character secret from crypto.getRandomValues, a new one each time", () => {
    const a = generateSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(a);
    let calls = 0;
    const fake = { getRandomValues: <T extends ArrayBufferView | null>(arr: T): T => (calls++, (arr as unknown as Uint8Array).fill(255), arr) };
    expect(generateSecret(fake)).toBe("ff".repeat(32));
    expect(calls).toBe(1);
  });

  it("fills every by-hand value", () => {
    const v = byHandValues({ teamName: "Fake Team", hubOrigin: "https://hub.example.com/", letters: "wxyz", secret: generateSecret() });
    expect(v.appName).toBe("Mergeport Fake Team wxyz");
    expect(v.homepageUrl).toBe("https://hub.example.com");
    expect(v.webhookUrl).toBe("https://hub.example.com/webhooks/github");
    expect(v.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(v.permissions.map((p) => p.name)).toEqual(["issues", "pull_requests", "checks", "statuses", "metadata"]);
    expect(v.events).toContain("pull_request_review_comment");
  });

  it("words every failure reason as a plain sentence and never echoes the reason text", () => {
    for (const r of ["state", "bad-code", "refused", "network", "bad-answer", "signin", "owner", "hub", "<script>alert(1)</script>", undefined]) {
      const t = appFailureText(r);
      expect(t).toMatch(/^[A-Z].*[.]$/);
      expect(t).not.toContain("<script>");
    }
  });
});
