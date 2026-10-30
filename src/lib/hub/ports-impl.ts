import path from "node:path";
import { createPrisma, resolveDbFile, type Db } from "@/lib/db";
import { HubForbidden, HubRequestError, HubUnauthorized, type HubAdminApi, type HubAdminSpace, type HubLinkStatus, type HubMember, type HubSessionPort, type HubWebhooks } from "@/lib/hub/ports";
import { clearHubSession, loadHubSession, openVault, saveHubSession } from "@/lib/hub/session-vault";
import type { HubLinkState } from "@/lib/hub/link";

/**
 * The hub profile ports on the real storage: the session token lives encrypted in the profile's `HubSession` row
 * (key file beside the db), the backend on `TeamConfig`. Every call opens the profile db it is given and closes it
 * again, because these run both inside the app (on another profile's file during connect) and from the launcher.
 */

export const keyFileFor = (dbFile: string) => path.join(path.dirname(dbFile), "key");

async function withDb<T>(dbFile: string, f: (db: Db) => Promise<T>): Promise<T> {
  const db = createPrisma(dbFile);
  try {
    return await f(db);
  } finally {
    await db.$disconnect();
  }
}

export const hubSessionPort: HubSessionPort = {
  async save(dbFile, s) {
    if (!/^\d+$/.test(s.githubId)) throw new Error("hub session needs a numeric GitHub id");
    const vault = openVault(keyFileFor(dbFile));
    await withDb(dbFile, (db) => saveHubSession(db, vault, { origin: s.origin, token: s.token, githubId: BigInt(s.githubId), login: s.login }));
  },
  async markProfile(dbFile, p) {
    await withDb(dbFile, async (db) => {
      const data = { mode: "TEAM" as const, backend: "HUB" as const, hubOrigin: p.origin, name: p.teamName };
      await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", ...data }, update: data });
    });
  },
  async read(dbFile) {
    const vault = openVault(keyFileFor(dbFile));
    const s = await withDb(dbFile, (db) => loadHubSession(db, vault));
    return s ? { origin: s.origin, token: s.token, githubId: String(s.githubId) } : null;
  },
  async remove(dbFile) {
    await withDb(dbFile, (db) => clearHubSession(db));
  },
};

const TIMEOUT_MS = 8000;

/** `GET /admin/spaces` answers `{ spaces: [{ id, kind, name, members: [{ githubId, canWrite }] }] }` (hub/src/admin-routes.ts). Entries that do not fit are skipped rather than trusted. */
export function parseAdminSpaces(raw: unknown): HubAdminSpace[] {
  const list = (raw as { spaces?: unknown } | null)?.spaces;
  if (!Array.isArray(list)) throw new HubRequestError("The server sent an unreadable answer", 200);
  const out: HubAdminSpace[] = [];
  for (const s of list as Record<string, unknown>[]) {
    if (!s || typeof s.id !== "string" || typeof s.name !== "string" || (s.kind !== "COMMON" && s.kind !== "RESTRICTED")) continue;
    const members = Array.isArray(s.members) ? (s.members as Record<string, unknown>[]).filter((m) => m && typeof m.githubId === "string").map((m) => ({ githubId: m.githubId as string, canWrite: m.canWrite === true })) : [];
    out.push({ id: s.id, kind: s.kind, name: s.name, members });
  }
  return out;
}

/** `/me.webhooks`. A hub without webhooks omits it, and a malformed value reads as "off": the panel never trusts it further than that. */
export function parseWebhooks(raw: unknown): HubWebhooks {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return { enabled: w.enabled === true, appSlug: str(w.appSlug), lastDeliveryAt: str(w.lastDeliveryAt), lastEvent: str(w.lastEvent) };
}

/** HTTP admin client against hub/src/{auth-routes,admin-routes}.ts. Errors never carry the token or the response body. */
export function httpHubAdmin(origin: string, token: () => Promise<string | null>, fetchImpl: typeof fetch = fetch): HubAdminApi {
  const call = async (method: string, p: string, body?: unknown): Promise<unknown> => {
    const t = await token();
    if (!t) throw new HubUnauthorized();
    const headers: Record<string, string> = { authorization: `Bearer ${t}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(`${origin}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new HubRequestError("Could not reach the server", 0);
    }
    if (res.status === 401) throw new HubUnauthorized();
    if (res.status === 403) throw new HubForbidden();
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      throw new HubRequestError(ra ? `The server is busy. Try again in ${ra} seconds.` : "The server is busy. Try again shortly.", 429, ra);
    }
    if (!res.ok) throw new HubRequestError(`The server answered ${res.status}`, res.status);
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new HubRequestError("The server sent an unreadable answer", res.status);
    }
  };
  const seg = encodeURIComponent;
  return {
    // GET /me -> { member, team: { id, name }, members, spaces: [{ id, kind, name, canWrite, seq }] }
    // `webhooks: { enabled, appSlug, lastDeliveryAt, lastEvent }` was added later; a hub without it reads as "off".
    me: async () => {
      const r = (await call("GET", "/me")) as (Omit<Awaited<ReturnType<HubAdminApi["me"]>>, "webhooks"> & { webhooks?: unknown }) | null;
      if (!r) throw new HubRequestError("The server sent an unreadable answer", 200);
      return { ...r, webhooks: parseWebhooks(r.webhooks) };
    },
    // POST /admin/invites { githubLogin, role } -> 201 { invite }
    invite: async (login, role) => void (await call("POST", "/admin/invites", { githubLogin: login, role })),
    // DELETE /admin/members/:githubId -> 204
    removeMember: async (id) => void (await call("DELETE", `/admin/members/${seg(id)}`)),
    // GET /admin/members -> { members: [{ githubId, login, name, avatarUrl, role, status }] } (all statuses; ADMIN+)
    removedMembers: async () => {
      const list = ((await call("GET", "/admin/members")) as { members?: unknown } | null)?.members;
      if (!Array.isArray(list)) throw new HubRequestError("The server sent an unreadable answer", 200);
      return (list as HubMember[]).filter((m) => m && typeof m.githubId === "string" && typeof m.login === "string" && m.status === "REMOVED");
    },
    // POST /admin/members/:githubId/reinstate { role } -> 200 { member } (OWNER)
    reinstateMember: async (id, role) => void (await call("POST", `/admin/members/${seg(id)}/reinstate`, { role })),
    // PATCH /admin/members/:githubId { role } -> 200 { member }
    setRole: async (id, role) => void (await call("PATCH", `/admin/members/${seg(id)}`, { role })),
    adminSpaces: async () => parseAdminSpaces(await call("GET", "/admin/spaces")),
    // POST /admin/spaces { name, members } -> 201 { space: { id, kind, name, members } }; a new space starts at seq 0 and the
    // creator writes to it only when listed among its members.
    createSpace: async (name, members) => {
      const r = (await call("POST", "/admin/spaces", { name, members })) as { space?: { id?: unknown; kind?: unknown; name?: unknown } } | null;
      const s = r?.space;
      if (!s || typeof s.id !== "string" || typeof s.name !== "string" || (s.kind !== "COMMON" && s.kind !== "RESTRICTED")) throw new HubRequestError("The server sent an unreadable answer", 201);
      return { id: s.id, kind: s.kind, name: s.name, canWrite: members.some((m) => m.canWrite), seq: "0" };
    },
    // PATCH /admin/spaces/:id { name?, members? } -> 200 { space }
    updateSpace: async (id, p) => void (await call("PATCH", `/admin/spaces/${seg(id)}`, p)),
    // DELETE /admin/spaces/:id -> 204
    deleteSpace: async (id) => void (await call("DELETE", `/admin/spaces/${seg(id)}`)),
    // PUT /admin/github-webhook { secret, appSlug? } -> 204 (OWNER). The secret is only ever sent, never read back or logged.
    setGithubWebhook: async (secret, appSlug) => void (await call("PUT", "/admin/github-webhook", appSlug ? { secret, appSlug } : { secret })),
    // DELETE /admin/github-webhook -> 204 (OWNER)
    clearGithubWebhook: async () => void (await call("DELETE", "/admin/github-webhook")),
    // POST /auth/logout -> 204
    logout: async () => void (await call("POST", "/auth/logout")),
  };
}

/** Set by the runtime when it starts the live link for this process's profile; read by `hubLinkStatus`. */
let liveState: (() => HubLinkState) | null = null;
export function registerHubLinkState(get: (() => HubLinkState) | null): void {
  liveState = get;
}

export function mapLinkState(s: HubLinkState | null): Pick<HubLinkStatus, "state" | "needsSignIn"> {
  switch (s) {
    case "live":
      return { state: "live", needsSignIn: false };
    case "reconnecting":
      return { state: "reconnecting", needsSignIn: false };
    case "signed-out":
      return { state: "offline", needsSignIn: true };
    default:
      return { state: "offline", needsSignIn: false };
  }
}

/**
 * The live link of the running app plus the ops not yet accepted by the hub. Another profile's file (one this process is
 * not running) has no link, so it reads as offline.
 */
export async function hubLinkStatus(dbFile: string): Promise<HubLinkStatus> {
  const mine = path.resolve(dbFile) === resolveDbFile();
  const link = mine && liveState ? liveState() : null;
  const base = mapLinkState(link);
  return withDb(dbFile, async (db) => {
    const pendingOps = await db.outboxOp.count({ where: { status: { in: ["PENDING", "CONFLICT"] }, space: { backend: "HUB" } } });
    return { ...base, pendingOps };
  });
}
