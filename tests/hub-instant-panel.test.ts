import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrisma, type Db } from "@/lib/db";
import { resetEnvCache } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { GitHubRest } from "@/lib/github/rest";
import { hubBackendId } from "@/lib/local/backends";
import { ensureLocalProfile } from "@/lib/local/profile";
import { HubForbidden, HubRequestError, type HubAdminApi, type HubLinkStatus, type HubMember, type HubWebhooks } from "@/lib/hub/ports";
import { httpHubAdmin, parseWebhooks } from "@/lib/hub/ports-impl";
import { readCoverage, saveCoverage } from "@/lib/hub/github-app-install";
import { HubTeamService } from "@/lib/team/hub-service";
import { FAKE_SESSION, FAKE_WEBHOOK_SECRET, startFakeHub, type FakeMember } from "./fake-hub";

const h = vi.hoisted(() => ({
  db: null as unknown as Db,
  getHubTeamService: vi.fn(),
  rest: null as unknown,
  link: { state: "live", pendingOps: 0, needsSignIn: false } as { state: string; pendingOps: number; needsSignIn: boolean },
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), get db() { return h.db; } }));
vi.mock("@/lib/local/runtime", () => ({ getTeamService: async () => null, getEngine: async () => null, getHubTeamService: h.getHubTeamService, syncSoon: () => {} }));
vi.mock("@/lib/local/workspaces", () => ({ currentBackend: async () => hubBackendId("https://hub.example.com") }));
vi.mock("@/lib/auth/current", () => ({ requireViewer: async () => ({ user: { githubId: 2n, login: "adm" }, viewer: { login: "adm", timezone: "UTC", isAdmin: true, workspaceId: (globalThis as { __ws?: string }).__ws }, csrf: "x" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/hub/ports-impl", async (orig) => ({ ...(await orig<typeof import("@/lib/hub/ports-impl")>()), hubLinkStatus: async () => h.link as HubLinkStatus }));
vi.mock("@/lib/hub/github-app-install", async (orig) => ({ ...(await orig<typeof import("@/lib/hub/github-app-install")>()), profileRest: () => h.rest }));

const ORIGIN = "https://hub.example.com";
const member = (githubId: string, login: string, role: HubMember["role"]): HubMember => ({ githubId, login, name: null, avatarUrl: null, role, status: "ACTIVE" });
const people = [member("1", "boss", "OWNER"), member("2", "adm", "ADMIN"), member("3", "mem", "MEMBER")];
const OFF: HubWebhooks = { enabled: false, appSlug: null, lastDeliveryAt: null, lastEvent: null };

function apiFor(me: string, webhooks: HubWebhooks, calls: string[] = []): HubAdminApi {
  return {
    me: async () => ({ member: people.find((p) => p.githubId === me)!, team: { name: "Fake Team" }, members: people, spaces: [], webhooks }),
    invite: async () => {},
    removeMember: async () => {},
    removedMembers: async () => [],
    reinstateMember: async () => {},
    setRole: async () => {},
    adminSpaces: async () => [],
    createSpace: async () => ({ id: "s", kind: "RESTRICTED", name: "s", canWrite: true, seq: "0" }),
    updateSpace: async () => {},
    deleteSpace: async () => {},
    setGithubWebhook: async (s, slug) => void calls.push(`set:${s.length}:${slug ?? ""}`),
    clearGithubWebhook: async () => void calls.push("clear"),
    logout: async () => {},
  };
}
const mockApi = (api: HubAdminApi, actor: string) => h.getHubTeamService.mockResolvedValue({ svc: new HubTeamService(api, actor), dbFile: "x.db", origin: ORIGIN });
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};

let home: string;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-instant-"));
  process.env.MERGEPORT_HOME = home;
  resetEnvCache();
  vi.clearAllMocks();
  h.db = createPrisma(path.join(home, "t.db"));
  (globalThis as { __ws?: string }).__ws = undefined;
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await h.db.$disconnect();
  delete process.env.MERGEPORT_HOME;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("admin API: /me.webhooks and the two admin routes", () => {
  const people2: FakeMember[] = [{ githubId: "1", login: "boss", role: "OWNER" }, { githubId: "2", login: "adm", role: "ADMIN" }, { githubId: "3", login: "mem", role: "MEMBER" }];
  async function setup(actor: string, webhook?: NonNullable<Parameters<typeof startFakeHub>[0]>["webhook"]) {
    const hub = await startFakeHub({ members: people2.map((p) => ({ ...p })), githubId: actor, webhook });
    stops.push(hub.stop);
    const api = httpHubAdmin(hub.origin, async () => FAKE_SESSION);
    return { hub, api, svc: new HubTeamService(api, actor) };
  }

  it("me() carries the webhook status, and a hub without the field reads as off", async () => {
    const { api } = await setup("1", { secret: FAKE_WEBHOOK_SECRET, appSlug: "team-app", lastDeliveryAt: "2026-10-30T10:00:00Z", lastEvent: "issues" });
    expect((await api.me()).webhooks).toEqual({ enabled: true, appSlug: "team-app", lastDeliveryAt: "2026-10-30T10:00:00Z", lastEvent: "issues" });
    expect((await (await setup("1")).api.me()).webhooks).toEqual(OFF);
    expect(parseWebhooks(undefined)).toEqual(OFF);
    expect(parseWebhooks("x")).toEqual(OFF);
    expect(parseWebhooks({ enabled: "yes", appSlug: 5 })).toEqual(OFF);
  });

  it("OWNER stores the secret and slug; /me then says enabled and never shows the secret; DELETE turns it off", async () => {
    const { hub, svc } = await setup("1");
    await svc.setGithubWebhook("a".repeat(64), "team-app");
    expect(hub.requests.filter((r) => r.method === "PUT")).toEqual([{ method: "PUT", path: "/admin/github-webhook", body: { secret: "a".repeat(64), appSlug: "team-app" } }]);
    const o = await svc.overview();
    expect(o.webhooks).toMatchObject({ enabled: true, appSlug: "team-app" });
    expect(JSON.stringify(o)).not.toContain("a".repeat(64));
    await svc.clearGithubWebhook();
    expect(hub.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/admin/github-webhook" });
    expect((await svc.overview()).webhooks.enabled).toBe(false);
  });

  it("without a slug the body carries the secret only", async () => {
    const { hub, svc } = await setup("1");
    await svc.setGithubWebhook("b".repeat(32));
    expect(hub.requests.at(-1)?.body).toEqual({ secret: "b".repeat(32) });
  });

  it("ADMIN and MEMBER are refused (the service says so before a request; the hub says 403)", async () => {
    for (const actor of ["2", "3"]) {
      const { hub, svc, api } = await setup(actor);
      await expect(svc.setGithubWebhook("a".repeat(64))).rejects.toBeInstanceOf(ValidationError);
      await expect(svc.clearGithubWebhook()).rejects.toBeInstanceOf(ValidationError);
      expect(hub.requests.some((r) => r.path === "/admin/github-webhook")).toBe(false);
      await expect(api.setGithubWebhook("a".repeat(64))).rejects.toBeInstanceOf(HubForbidden);
    }
  });

  it("a secret outside 32 to 256 characters or a bad slug is refused, and the error never echoes the secret", async () => {
    const { svc, api } = await setup("1");
    const err = await svc.setGithubWebhook("short-secret-value").catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).not.toContain("short-secret-value");
    await expect(svc.setGithubWebhook("a".repeat(257))).rejects.toBeInstanceOf(ValidationError);
    await expect(svc.setGithubWebhook("a".repeat(40), "bad/slug")).rejects.toBeInstanceOf(ValidationError);
    const hubErr = await api.setGithubWebhook("tiny-secret").catch((e) => e);
    expect(hubErr).toBeInstanceOf(HubRequestError);
    expect(hubErr.message).not.toContain("tiny-secret");
  });
});

async function renderTeam(me: string, webhooks: HubWebhooks, githubApp?: { result: "created" | "failed"; reason?: string }) {
  mockApi(apiFor(me, webhooks), me);
  const { HubTeamPage } = await import("@/components/team/HubTeamPage");
  return renderToStaticMarkup(await HubTeamPage({ backend: hubBackendId(ORIGIN), githubApp }));
}

describe("panel: who sees what", () => {
  it("only the OWNER sees step 1 and the by-hand section; everyone sees the status line and steps 2 and 3", async () => {
    const owner = await renderTeam("1", OFF);
    expect(owner).toContain("Instant GitHub updates");
    expect(owner).toContain("1. Create the GitHub App");
    expect(owner).toContain("Create the GitHub App on GitHub");
    expect(owner).toContain("my GitHub account");
    expect(owner).toContain("an organisation");
    expect(owner).toContain("Let teammates install it on their own repositories");
    expect(owner).toContain("Also refresh branches and commits instantly");
    expect(owner).toContain("Set it up by hand");
    for (const me of ["1", "2", "3"]) {
      const html = await renderTeam(me, { ...OFF, enabled: true, appSlug: "team-app" });
      expect(html).toContain("2. Cover your repositories");
      expect(html).toContain("3. Check");
      expect(html).toContain("Check now");
    }
    for (const me of ["2", "3"]) {
      const html = await renderTeam(me, OFF);
      expect(html).not.toContain("1. Create the GitHub App");
      expect(html).not.toContain("Create the GitHub App on GitHub");
      expect(html).not.toContain("Set it up by hand");
      expect(html).toContain("Not set up");
    }
  });

  it("step 1 is done once the hub says enabled, and the by-hand section then offers Turn off", async () => {
    const html = await renderTeam("1", { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null });
    expect(html).not.toContain("Create the GitHub App on GitHub");
    expect(html).toContain("Done.");
    expect(html).toContain("team-app");
    expect(html).toContain("Turn off");
  });

  it("each status has its text", async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    expect(await renderTeam("3", OFF)).toContain("Not set up");
    const waiting = await renderTeam("3", { enabled: true, appSlug: "a", lastDeliveryAt: null, lastEvent: null });
    expect(waiting).toContain("Waiting for the first event from GitHub");
    expect(waiting).toContain("Install the App on a repository (GitHub sends an event when you do), then edit an issue to see it arrive instantly.");
    expect(waiting).toContain("GitHub could not reach the server. If Cloudflare is in front, add a skip rule for the path /webhooks/github.");
    const on = await renderTeam("3", { enabled: true, appSlug: "a", lastDeliveryAt: recent, lastEvent: "issues" });
    expect(on).toContain("Instant GitHub updates are on");
    expect(on).not.toContain("Waiting for the first event");
  });

  it("shows where GitHub sent the owner back to: created, or failed with a plain sentence", async () => {
    expect(await renderTeam("1", { ...OFF, enabled: true }, { result: "created" })).toContain("Created. The secret is saved on your server.");
    const failed = await renderTeam("1", OFF, { result: "failed", reason: "refused" });
    expect(failed).toContain("GitHub did not accept the App. Nothing was saved.");
    expect(failed).not.toContain("refused");
  });

  it("keeps every existing Team page element", async () => {
    const html = await renderTeam("2", OFF);
    for (const t of ["Fake Team", "Members (3)", "Restricted spaces (0)", "Invite", "Sign out of this server", "Live"]) expect(html).toContain(t);
  });

  it("a hub that cannot be reached shows no panel and no error from it", async () => {
    h.getHubTeamService.mockResolvedValue({ svc: new HubTeamService({ ...apiFor("1", OFF), me: async () => { throw new HubRequestError("The server is busy.", 429); } }, "1"), dbFile: "x.db", origin: ORIGIN });
    const { HubTeamPage } = await import("@/components/team/HubTeamPage");
    const html = renderToStaticMarkup(await HubTeamPage({ backend: hubBackendId(ORIGIN) }));
    expect(html).toContain("Could not load the team from the server");
    expect(html).not.toContain("Instant GitHub updates");
  });
});

describe("panel: repositories and the hidden form", () => {
  it("lists tracked repositories as Covered or Not installed yet", async () => {
    const { InstantUpdatesPanel } = await import("@/components/team/InstantUpdatesPanel");
    const html = renderToStaticMarkup(
      InstantUpdatesPanel({
        teamName: "T", origin: ORIGIN, isOwner: false, webhooks: { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null },
        tracked: [{ id: "a", githubId: "11", fullName: "acme/one" }, { id: "b", githubId: "12", fullName: "acme/two" }], covered: new Set(["11"]),
      }),
    );
    expect(html).toMatch(/acme\/one[\s\S]*?Covered/);
    expect(html).toMatch(/acme\/two[\s\S]*?Not installed yet/);
    expect(html).toContain("Add my tracked repositories");
    expect(html).toContain("https://github.com/apps/team-app/installations/new");
  });

  it("the hidden form posts the manifest field to the action URL that `start` answered", async () => {
    const { ManifestForm } = await import("@/components/team/GithubAppCreate");
    const { buildManifest, manifestActionUrl } = await import("@/lib/hub/github-app-manifest");
    const manifest = buildManifest({ teamName: "T", hubOrigin: ORIGIN, port: 3000, teammates: true, contents: false, randomLetters: () => "abcd" });
    const actionUrl = manifestActionUrl({ kind: "personal" }, "STATE123");
    const html = renderToStaticMarkup(ManifestForm({ actionUrl, manifest, state: "STATE123" }));
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="${actionUrl}"`);
    expect(html).toContain("hidden");
    expect(html.match(/<input/g)).toHaveLength(1);
    const value = /name="manifest" value="([^"]*)"/.exec(html)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(JSON.parse(value)).toEqual(manifest);
  });

  it('"Generate" fills every value: name, URLs, a 64-hex secret, permissions and events', async () => {
    const { ByHandValuesView } = await import("@/components/team/WebhookByHand");
    const { byHandValues, generateSecret } = await import("@/lib/hub/webhook-panel");
    const v = byHandValues({ teamName: "Fake Team", hubOrigin: ORIGIN, letters: "qrst", secret: generateSecret() });
    const html = renderToStaticMarkup(ByHandValuesView({ v }));
    expect(v.secret).toMatch(/^[0-9a-f]{64}$/);
    for (const t of ["Mergeport Fake Team qrst", ORIGIN, `${ORIGIN}/webhooks/github`, v.secret, "pull_requests", "check_suite", "Copy permissions", "Copy events"]) expect(html).toContain(t);
    expect(html.match(/value="/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("before Generate the by-hand section holds no secret and no save form", async () => {
    const html = await renderTeam("1", OFF);
    expect(html).toContain("Generate");
    expect(html).not.toContain("Save secret on the server");
    expect(html).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("actions", () => {
  async function seedRepos() {
    const { workspace } = await ensureLocalProfile(h.db, { id: 2n, login: "adm", name: "adm", avatarUrl: null, host: "github.com" });
    (globalThis as { __ws?: string }).__ws = workspace.id;
    const owner = await h.db.githubOwner.create({ data: { githubId: 500n, login: "acme", type: "ORGANIZATION" } });
    const mk = (githubId: bigint, name: string, extra: object = {}) =>
      h.db.repository.create({ data: { workspaceId: workspace.id, githubId, ownerId: owner.id, name, fullName: `acme/${name}`, htmlUrl: `https://github.com/acme/${name}`, ...extra } });
    await mk(11n, "one");
    await mk(12n, "two");
    await mk(13n, "disconnected", { trackingStatus: "DISCONNECTED" });
    return workspace;
  }
  const github = (put: Record<string, number> = {}) => {
    const calls: string[] = [];
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    h.rest = new GitHubRest((async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      calls.push(`${init.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/user/installations") return json(200, { installations: [{ id: 1, app_slug: "team-app", account: { login: "acme" } }] });
      if (u.pathname === "/user/installations/1/repositories" && init.method !== "PUT") return json(200, { repositories: [{ id: 11 }] });
      const m = /\/repositories\/(\d+)$/.exec(u.pathname);
      if (init.method === "PUT" && m) return (put[m[1]] ?? 204) === 204 ? new Response(null, { status: 204 }) : json(put[m[1]], { message: "no" });
      return json(404, {});
    }) as unknown as typeof fetch);
    return calls;
  };

  it("Add my tracked repositories adds only the uncovered ACTIVE ones and remembers the coverage for the badge", async () => {
    await seedRepos();
    mockApi(apiFor("2", { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null }), "2");
    const calls = github();
    const { addTrackedRepositoriesAction } = await import("@/app/hub-webhook-actions");
    const r = await addTrackedRepositoriesAction();
    expect(r).toEqual({ ok: true, message: "Added 1 repository to the App." });
    expect(calls).toEqual(["GET /user/installations", "GET /user/installations/1/repositories", "PUT /user/installations/1/repositories/12"]);
    expect([...(await readCoverage(h.db, "team-app"))].sort()).toEqual(["11", "12"]);
    expect((await readCoverage(h.db, "other-app")).size).toBe(0);
  });

  it("reports a refused repository by name with the install instruction", async () => {
    await seedRepos();
    mockApi(apiFor("2", { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null }), "2");
    github({ "12": 403 });
    const { addTrackedRepositoriesAction } = await import("@/app/hub-webhook-actions");
    const r = await addTrackedRepositoriesAction();
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("Install it on this repository on GitHub: acme/two.");
  });

  it("refuses before any GitHub request when the App is not set up", async () => {
    await seedRepos();
    mockApi(apiFor("2", OFF), "2");
    const calls = github();
    const { addTrackedRepositoriesAction } = await import("@/app/hub-webhook-actions");
    expect(await addTrackedRepositoriesAction()).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("Check now words each state", async () => {
    const { checkInstantUpdatesAction } = await import("@/app/hub-webhook-actions");
    mockApi(apiFor("3", { enabled: true, appSlug: "a", lastDeliveryAt: null, lastEvent: null }), "3");
    expect(await checkInstantUpdatesAction()).toEqual({ ok: true, message: "Install the App on a repository (GitHub sends an event when you do), then edit an issue to see it arrive instantly." });
    mockApi(apiFor("3", { enabled: true, appSlug: "a", lastDeliveryAt: new Date().toISOString(), lastEvent: "issues" }), "3");
    expect(await checkInstantUpdatesAction()).toMatchObject({ ok: true, message: expect.stringContaining("Instant GitHub updates are on") });
    mockApi(apiFor("3", OFF), "3");
    expect(await checkInstantUpdatesAction()).toMatchObject({ ok: true, message: expect.stringContaining("Not set up") });
  });

  it("Save secret on the server and Turn off call the hub as the OWNER, and Turn off forgets the coverage", async () => {
    const calls: string[] = [];
    mockApi(apiFor("1", { enabled: true, appSlug: "team-app", lastDeliveryAt: null, lastEvent: null }, calls), "1");
    const { saveWebhookSecretAction, turnOffInstantUpdatesAction } = await import("@/app/hub-webhook-actions");
    expect(await saveWebhookSecretAction(fd({ secret: "c".repeat(64), appSlug: "team-app" }))).toMatchObject({ ok: true });
    expect(await saveWebhookSecretAction(fd({ secret: "c".repeat(64) }))).toMatchObject({ ok: true });
    await saveCoverage(h.db, { appSlug: "team-app", checkedAt: new Date().toISOString(), covered: ["11"] });
    expect(await turnOffInstantUpdatesAction()).toMatchObject({ ok: true });
    expect(calls).toEqual(["set:64:team-app", "set:64:", "clear"]);
    expect((await readCoverage(h.db)).size).toBe(0);
    mockApi(apiFor("3", OFF, calls), "3");
    expect(await saveWebhookSecretAction(fd({ secret: "c".repeat(64) }))).toMatchObject({ ok: false, error: "Only the owner can set up instant GitHub updates." });
    expect(await turnOffInstantUpdatesAction()).toMatchObject({ ok: false });
    expect(calls).toHaveLength(3);
  });
});
