import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { hubBackendId } from "@/lib/local/backends";
import { writeActive } from "@/lib/local/registry";
import { HubForbidden, HubRequestError, HubUnauthorized, type HubAdminApi, type HubLinkStatus, type HubMember } from "@/lib/hub/ports";
import { HubTeamService } from "@/lib/team/hub-service";

const mocks = vi.hoisted(() => ({
  getTeamService: vi.fn(async () => null),
  getEngine: vi.fn(async () => null),
  getHubTeamService: vi.fn(),
  link: { state: "live", pendingOps: 0, needsSignIn: false } as { state: string; pendingOps: number; needsSignIn: boolean },
}));
vi.mock("@/lib/local/runtime", () => ({ getTeamService: mocks.getTeamService, getEngine: mocks.getEngine, getHubTeamService: mocks.getHubTeamService, syncSoon: () => {} }));
vi.mock("@/lib/auth/current", () => ({ requireViewer: async () => ({ user: { githubId: 2n, login: "adm" }, viewer: { login: "adm", timezone: "UTC", isAdmin: true }, csrf: "x" }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/hub/ports-impl", async (orig) => ({ ...(await orig<typeof import("@/lib/hub/ports-impl")>()), hubLinkStatus: async () => mocks.link as HubLinkStatus }));

const ORIGIN = "https://hub.example.com";
const member = (githubId: string, login: string, role: HubMember["role"], status: HubMember["status"] = "ACTIVE"): HubMember => ({ githubId, login, name: null, avatarUrl: null, role, status });
const people = [member("1", "boss", "OWNER"), member("2", "adm", "ADMIN"), member("3", "mem", "MEMBER")];
const spaces = [
  { id: "c", kind: "COMMON" as const, name: "Common", canWrite: true, seq: "1" },
  { id: "r1", kind: "RESTRICTED" as const, name: "Secret", canWrite: true, seq: "2" },
];

const WEBHOOKS_OFF = { enabled: false, appSlug: null, lastDeliveryAt: null, lastEvent: null };

function fakeApi(me: string, over: Partial<HubAdminApi> = {}) {
  const calls: string[] = [];
  const api: HubAdminApi = {
    me: async () => ({ member: people.find((p) => p.githubId === me)!, team: { name: "Fake Team" }, members: people, spaces, webhooks: WEBHOOKS_OFF }),
    setGithubWebhook: async (s, slug) => void calls.push(`webhook:${s.length}:${slug ?? ""}`),
    clearGithubWebhook: async () => void calls.push("webhook-off"),
    invite: async (l) => void calls.push(`invite:${l}`),
    removeMember: async (id) => void calls.push(`remove:${id}`),
    removedMembers: async () => [member("9", "gone", "MEMBER", "REMOVED")],
    reinstateMember: async (id, r) => void calls.push(`reinstate:${id}:${r}`),
    setRole: async (id, r) => void calls.push(`role:${id}:${r}`),
    adminSpaces: async () => [{ id: "c", kind: "COMMON", name: "Common", members: [] }, { id: "r1", kind: "RESTRICTED", name: "Secret", members: [{ githubId: "2", canWrite: true }, { githubId: "3", canWrite: false }] }],
    createSpace: async (n, m) => (calls.push(`space:${n}:${JSON.stringify(m)}`), spaces[1]),
    updateSpace: async () => {},
    deleteSpace: async (id) => void calls.push(`delete:${id}`),
    logout: async () => void calls.push("logout"),
    ...over,
  };
  return { api, calls };
}
const mockHub = (api: HubAdminApi, actor: string) => mocks.getHubTeamService.mockResolvedValue({ svc: new HubTeamService(api, actor), dbFile: "x.db", origin: ORIGIN });
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mp-hubteam-"));
  process.env.MERGEPORT_HOME = home;
  resetEnvCache();
  vi.clearAllMocks();
  mocks.link = { state: "live", pendingOps: 0, needsSignIn: false };
});
afterEach(() => {
  delete process.env.MERGEPORT_HOME;
  resetEnvCache();
  fs.rmSync(home, { recursive: true, force: true });
});

const setBackend = (b: string) => writeActive(home, { host: "github.com", accountId: "2", backend: b as never });

describe("Team page branching", () => {
  it("GitHub backend (no active.json): GitHub path, hub service untouched", async () => {
    const { default: TeamPage } = await import("@/app/(app)/team/page");
    await TeamPage({ searchParams: Promise.resolve({}) });
    expect(mocks.getTeamService).toHaveBeenCalled();
    expect(mocks.getHubTeamService).not.toHaveBeenCalled();
  });

  it("active.json says github: same", async () => {
    setBackend("github");
    const { default: TeamPage } = await import("@/app/(app)/team/page");
    await TeamPage({ searchParams: Promise.resolve({}) });
    expect(mocks.getTeamService).toHaveBeenCalled();
    expect(mocks.getHubTeamService).not.toHaveBeenCalled();
  });

  it("hub backend: hub page, no TeamService or engine call", async () => {
    const b = hubBackendId(ORIGIN);
    setBackend(b);
    const { default: TeamPage } = await import("@/app/(app)/team/page");
    const { HubTeamPage } = await import("@/components/team/HubTeamPage");
    const el = (await TeamPage({ searchParams: Promise.resolve({}) })) as { type: unknown; props: { backend: string } };
    expect(el.type).toBe(HubTeamPage);
    expect(el.props.backend).toBe(b);
    expect(mocks.getTeamService).not.toHaveBeenCalled();
    expect(mocks.getEngine).not.toHaveBeenCalled();
  });
});

async function render(me: string, over: Partial<HubAdminApi> = {}) {
  const { api, calls } = fakeApi(me, over);
  mockHub(api, me);
  const { HubTeamPage } = await import("@/components/team/HubTeamPage");
  return { html: renderToStaticMarkup(await HubTeamPage({ backend: hubBackendId(ORIGIN) })), calls };
}

describe("HubTeamPage rendering", () => {
  it("admin sees team, origin, members, admin controls, spaces and sign out", async () => {
    const { html } = await render("2");
    expect(html).toContain("Fake Team");
    expect(html).toContain("hub.example.com");
    expect(html).toContain("@boss");
    expect(html).toContain("Invite");
    expect(html).toContain("Delete space");
    expect(html).toContain("Secret");
    expect(html).toContain("Sign out of this server");
    expect(html).toContain("Live");
    expect(html).not.toContain("pending");
  });

  it("the owner sees removed people with a Reinstate control; an admin does not", async () => {
    const owner = (await render("1")).html;
    expect(owner).toContain("@gone");
    expect(owner).toContain("Reinstate");
    expect(owner).toContain("restricted spaces are granted again on purpose");
    const adm = (await render("2")).html;
    expect(adm).not.toContain("@gone");
    expect(adm).not.toContain("Reinstate");
  });

  it("admin sees each restricted space's members with their access", async () => {
    const { html } = await render("2");
    expect(html).toContain("Members of this space");
    expect(html).toContain("@mem");
    expect(html).toContain("Read only");
    expect(html).toContain("Can edit");
  });

  it("adminSpaces failure degrades to the name-only list", async () => {
    const { html } = await render("2", { adminSpaces: async () => { throw new HubRequestError("boom", 500); } });
    expect(html).toContain("Secret");
    expect(html).not.toContain("Members of this space");
    expect(html).toContain("Sign out of this server");
  });

  it("member never triggers adminSpaces", async () => {
    const adminSpaces = vi.fn(async () => []);
    const { html } = await render("3", { adminSpaces });
    expect(adminSpaces).not.toHaveBeenCalled();
    expect(html).not.toContain("Members of this space");
  });

  it("action role helper refuses a non-role before the service", async () => {
    setBackend(hubBackendId(ORIGIN));
    const { api, calls } = fakeApi("2");
    mockHub(api, "2");
    const a = await import("@/app/hub-team-actions");
    expect(await a.hubInviteAction(fd({ login: "zed", role: "OWNER" }))).toMatchObject({ ok: false });
    expect(await a.hubInviteAction(fd({ login: "zed" }))).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("member sees no admin controls but can sign out", async () => {
    const { html } = await render("3");
    expect(html).not.toContain("Invite");
    expect(html).not.toContain("Delete space");
    expect(html).not.toContain("Save role");
    expect(html).toContain("Sign out of this server");
  });

  it("owner row has no role select or remove", async () => {
    const { html } = await render("2");
    expect(html).not.toContain("Remove @boss");
    expect(html).toContain("Remove @mem");
  });

  it("connection pill and pending count come from hubLinkStatus", async () => {
    mocks.link = { state: "reconnecting", pendingOps: 4, needsSignIn: false };
    const { html } = await render("2");
    expect(html).toContain("Reconnecting");
    expect(html).toContain("4 pending");
  });

  it("needsSignIn shows the re-sign-in banner with the connect link", async () => {
    mocks.link = { state: "offline", pendingOps: 0, needsSignIn: true };
    const { html } = await render("2");
    expect(html).toContain("Sign in to the server again");
    expect(html).toContain('href="/sign-in?connect=1"');
    expect(html).toContain("Offline");
  });

  it("HubUnauthorized renders the re-sign-in text, not an exception", async () => {
    const { html } = await render("2", { me: async () => { throw new HubUnauthorized(); } });
    expect(html).toContain("Sign in to the server again");
    expect(html).toContain('href="/sign-in?connect=1"');
    expect(html).toContain("Sign out of this server");
  });

  it("HubForbidden says the user was removed and shows no team data", async () => {
    const { html } = await render("2", { me: async () => { throw new HubForbidden(); } });
    expect(html).toContain("You were removed from this team.");
    expect(html).not.toContain("@boss");
    expect(html).not.toContain("Invite");
  });

  it("HubRequestError renders inline and the page still renders", async () => {
    const { html } = await render("2", { me: async () => { throw new HubRequestError("The server is busy. Try again shortly.", 429); } });
    expect(html).toContain("The server is busy. Try again shortly.");
    expect(html).toContain("Sign out of this server");
  });

  it("delete confirm dialog carries the exact warning", async () => {
    const { html } = await render("2");
    // The dialog content is mounted only when open; the text lives in the trigger's description via the shared constant.
    const { DELETE_SPACE_WARNING } = await import("@/components/team/HubTeamPanel");
    expect(DELETE_SPACE_WARNING).toBe("Deleting this space removes its projects, cards and tasks from every member's computer.");
    expect(html).toContain("Delete space");
  });
});

describe("hub team actions", () => {
  async function actions() {
    return import("@/app/hub-team-actions");
  }
  beforeEach(() => setBackend(hubBackendId(ORIGIN)));

  it("a MEMBER is rejected before any /admin call", async () => {
    const { api, calls } = fakeApi("3");
    mockHub(api, "3");
    const a = await actions();
    for (const r of [
      await a.hubInviteAction(fd({ login: "zed", role: "MEMBER" })),
      await a.hubChangeRoleAction(fd({ githubId: "2", role: "READER" })),
      await a.hubRemoveMemberAction(fd({ githubId: "2" })),
      await a.hubCreateSpaceAction(fd({ name: "x" })),
      await a.hubDeleteSpaceAction(fd({ spaceId: "r1", confirm: "on" })),
    ]) expect(r).toMatchObject({ ok: false, error: expect.stringContaining("Only admins can") });
    expect(calls).toEqual([]);
  });

  it("an admin's role change reaches the hub; an invalid role value does not", async () => {
    const { api, calls } = fakeApi("2");
    mockHub(api, "2");
    const a = await actions();
    expect(await a.hubChangeRoleAction(fd({ githubId: "3", role: "READER" }))).toMatchObject({ ok: true });
    expect(await a.hubChangeRoleAction(fd({ githubId: "3", role: "OWNER" }))).toMatchObject({ ok: false });
    expect(calls).toEqual(["role:3:READER"]);
  });

  it("delete needs the confirm field", async () => {
    const { api, calls } = fakeApi("2");
    mockHub(api, "2");
    const a = await actions();
    expect(await a.hubDeleteSpaceAction(fd({ spaceId: "r1" }))).toMatchObject({ ok: false, error: expect.stringContaining("removes its projects, cards and tasks") });
    expect(await a.hubDeleteSpaceAction(fd({ spaceId: "r1", confirm: "on" }))).toMatchObject({ ok: true });
    expect(calls).toEqual(["delete:r1"]);
  });

  it("create space keeps only people the hub lists as members", async () => {
    const { api, calls } = fakeApi("2");
    mockHub(api, "2");
    const a = await actions();
    await a.hubCreateSpaceAction(fd({ name: "Ops", member: ["2", "3", "999"], write: ["2", "999"] }));
    expect(calls).toEqual([`space:Ops:${JSON.stringify([{ githubId: "2", canWrite: true }, { githubId: "3", canWrite: false }])}`]);
  });

  it("hub failures become messages", async () => {
    const a = await actions();
    mockHub(fakeApi("2", { me: async () => { throw new HubUnauthorized(); } }).api, "2");
    expect(await a.hubInviteAction(fd({ login: "zed", role: "MEMBER" }))).toEqual({ ok: false, error: "Sign in to the server again." });
    mockHub(fakeApi("2", { me: async () => { throw new HubForbidden(); } }).api, "2");
    expect(await a.hubInviteAction(fd({ login: "zed", role: "MEMBER" }))).toMatchObject({ ok: false, error: expect.stringContaining("removed from this team") });
  });

  it("refuses when the workspace is GitHub", async () => {
    writeActive(home, { host: "github.com", accountId: "2", backend: "github" });
    const { api } = fakeApi("2");
    mockHub(api, "2");
    const a = await actions();
    expect(await a.hubInviteAction(fd({ login: "zed" }))).toMatchObject({ ok: false });
    expect(mocks.getHubTeamService).not.toHaveBeenCalled();
  });

  it("sign out ends the hub session then forgets it locally", async () => {
    const { api, calls } = fakeApi("2");
    const remove = vi.fn(async () => {});
    const svc = new HubTeamService(api, "2");
    mocks.getHubTeamService.mockResolvedValue({ svc: Object.assign(svc, { signOut: (db: string) => HubTeamService.prototype.signOut.call(svc, db, { remove }) }), dbFile: "x.db", origin: ORIGIN });
    const a = await actions();
    expect(await a.hubSignOutAction()).toMatchObject({ ok: true, data: { switchTo: "github" } });
    expect(calls).toEqual(["logout"]);
    expect(remove).toHaveBeenCalledWith("x.db");
  });
});

