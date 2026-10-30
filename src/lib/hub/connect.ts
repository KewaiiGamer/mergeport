import { ValidationError } from "@/lib/errors";
import { createPrisma } from "@/lib/db";
import type { GhStatus } from "@/lib/github/gh";
import { hubBackendId, normalizeHubOrigin, type Backend } from "@/lib/local/backends";
import { ensureLocalProfile, profileDbPath } from "@/lib/local/profile";
import { upsertHub } from "@/lib/local/registry";
import type { HubSessionPort } from "@/lib/hub/ports";

/** Client side of the hub's health check and device sign-in. Error messages never carry codes or session tokens. */

export type DeviceStart = { deviceCode: string; pollSecret: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };
export type DevicePoll =
  | { status: "pending"; slowDown?: true }
  | { status: "ok"; session: string; member: { githubId: string; login: string }; team: { name: string } }
  | { status: "refused"; reason: "not-invited" | "removed" }
  | { status: "expired" };

const TIMEOUT_MS = 8000;
/** The final poll waits on GitHub twice (token, then profile); one slow answer there must not cost the person their sign-in. */
const POLL_TIMEOUT_MS = 30_000;

export class HubAuth {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async send(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    } catch {
      throw new ValidationError("Could not reach that server. Check the address and your connection.");
    }
  }

  private post(origin: string, p: string, body: unknown, timeoutMs?: number) {
    return this.send(`${origin}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
  }

  async health(typed: string, expectHost: string): Promise<{ origin: string; teamName: string | null; backend: Backend }> {
    const origin = normalizeHubOrigin(typed);
    const res = await this.send(`${origin}/health`);
    if (!res.ok) throw new ValidationError("That server did not answer like a Mergeport server.");
    let j: { ok?: unknown; team?: { name?: unknown } | null; publicUrl?: unknown; githubHost?: unknown };
    try {
      j = await res.json();
    } catch {
      throw new ValidationError("That server did not answer like a Mergeport server.");
    }
    if (!j || j.ok !== true) throw new ValidationError("That server is not ready.");
    let said: string;
    try {
      said = normalizeHubOrigin(String(j.publicUrl));
    } catch {
      said = String(j.publicUrl);
    }
    if (said !== origin) throw new ValidationError(`This server says it lives at ${said}, not ${origin}.`);
    if (j.githubHost !== expectHost) throw new ValidationError(`This server uses GitHub at ${String(j.githubHost)}, but this computer uses ${expectHost}.`);
    return { origin, teamName: j.team && typeof j.team.name === "string" ? j.team.name : null, backend: hubBackendId(origin) };
  }

  async start(origin: string): Promise<DeviceStart> {
    const o = normalizeHubOrigin(origin);
    const res = await this.post(o, "/auth/device/start", {});
    if (!res.ok) throw new ValidationError("The server could not start sign-in.");
    const j = (await res.json().catch(() => null)) as Partial<DeviceStart> | null;
    if (!j || typeof j.deviceCode !== "string" || typeof j.pollSecret !== "string" || typeof j.userCode !== "string" || typeof j.verificationUri !== "string") throw new ValidationError("The server sent an unexpected sign-in reply.");
    return { deviceCode: j.deviceCode, pollSecret: j.pollSecret, userCode: j.userCode, verificationUri: j.verificationUri, interval: Number(j.interval) || 5, expiresIn: Number(j.expiresIn) || 600 };
  }

  /** `slowDown` on a pending answer: GitHub asked for a longer interval; the caller adds 5 s before polling again. */
  async poll(origin: string, deviceCode: string, pollSecret: string): Promise<DevicePoll> {
    const o = normalizeHubOrigin(origin);
    const res = await this.post(o, "/auth/device/poll", { deviceCode, pollSecret }, POLL_TIMEOUT_MS);
    if (res.status === 202) {
      const j = (await res.json().catch(() => null)) as { slowDown?: unknown } | null;
      return j?.slowDown === true ? { status: "pending", slowDown: true } : { status: "pending" };
    }
    // 404: the server no longer knows this flow (restarted, finished elsewhere, or the secret did not match): start again.
    if (res.status === 410 || res.status === 404) return { status: "expired" };
    if (res.status === 403) {
      const j = (await res.json().catch(() => null)) as { reason?: unknown } | null;
      return { status: "refused", reason: j?.reason === "removed" ? "removed" : "not-invited" };
    }
    if (res.status === 200) {
      const j = (await res.json().catch(() => null)) as { session?: unknown; member?: { githubId?: unknown; login?: unknown }; team?: { name?: unknown } } | null;
      if (!j || typeof j.session !== "string" || !j.member || j.member.githubId === undefined || typeof j.member.login !== "string") throw new ValidationError("The server sent an unexpected sign-in reply.");
      return { status: "ok", session: j.session, member: { githubId: String(j.member.githubId), login: j.member.login }, team: { name: typeof j.team?.name === "string" ? j.team.name : "" } };
    }
    throw new ValidationError("The server could not check sign-in.");
  }
}

/**
 * The hub chooses the page the person is sent to, so it is only passed on when it is plain https on GitHub itself or on
 * this computer's GitHub host, without credentials. Anything else returns null.
 */
export function safeVerificationUri(uri: string, githubHost: string): string | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "") return null;
  if (u.hostname !== "github.com" && u.hostname !== githubHost) return null;
  return u.toString();
}

export type ConnectInput = {
  home: string;
  host: string;
  origin: string;
  teamName: string;
  session: string;
  member: { githubId: string; login: string };
  gh: GhStatus;
  ports: { session: HubSessionPort };
};

/**
 * Creates the hub profile for the account that signed in. Nothing is created unless `gh` is signed in as the same
 * numeric id the hub confirmed, so a hub profile is never opened as another account. active.json is NOT written here:
 * the launcher records the active workspace once the switch to it has succeeded, so a failed switch leaves the next
 * launch on the workspace that still works.
 */
export async function completeConnect(i: ConnectInput): Promise<{ ok: true; backend: Backend } | { ok: false; error: "mismatch" | "gh-login" | "gh-missing" | "gh-error" }> {
  if (i.gh.state === "not-logged-in") return { ok: false, error: "gh-login" };
  if (i.gh.state === "missing-gh") return { ok: false, error: "gh-missing" };
  if (i.gh.state !== "ok") return { ok: false, error: "gh-error" };
  if (!/^\d+$/.test(i.member.githubId)) return { ok: false, error: "mismatch" };
  if (i.gh.identity.id !== BigInt(i.member.githubId)) return { ok: false, error: "mismatch" };
  if (i.gh.identity.host && i.gh.identity.host !== i.host) return { ok: false, error: "mismatch" };
  const origin = normalizeHubOrigin(i.origin);
  const backend = hubBackendId(origin);
  const id = i.gh.identity;
  const dbFile = profileDbPath(i.home, i.host, id.id, backend);
  const prisma = createPrisma(dbFile);
  try {
    await ensureLocalProfile(prisma, id);
  } finally {
    await prisma.$disconnect();
  }
  await i.ports.session.save(dbFile, { origin, token: i.session, githubId: i.member.githubId, login: i.member.login });
  await i.ports.session.markProfile(dbFile, { backend, origin, teamName: i.teamName });
  upsertHub(i.home, { origin, teamName: i.teamName, lastSignedInAs: { id: i.member.githubId, login: i.member.login }, addedAt: new Date().toISOString() });
  return { ok: true, backend };
}
