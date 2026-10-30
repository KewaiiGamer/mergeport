import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { HubDb } from "./db";
import { HttpError } from "./http";
import type { Limiter } from "./ratelimit";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Role = "OWNER" | "ADMIN" | "MEMBER" | "READER";
export type Member = { githubId: bigint; login: string; name: string | null; avatarUrl: string | null; role: string; status: string };
export type Session = { idHash: string; githubId: bigint; clientName: string | null; expiresAt: string };
export type GithubIdentity = { id: bigint; login: string; name: string | null; avatarUrl: string | null };

const iso = (ms: number) => new Date(ms).toISOString();
const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

type MemberRow = { github_id: bigint; login: string; name: string | null; avatar_url: string | null; role: string; status: string };
export const toMember = (r: MemberRow): Member => ({ githubId: r.github_id, login: r.login, name: r.name, avatarUrl: r.avatar_url, role: r.role, status: r.status });

export function getMember(db: HubDb, githubId: bigint): Member | null {
  const r = db.prepare("SELECT * FROM member WHERE github_id = ?").safeIntegers(true).get(githubId) as MemberRow | undefined;
  return r ? toMember(r) : null;
}

/** Returns the raw token; only its SHA-256 hex is stored. */
export function createSession(db: HubDb, githubId: bigint, clientName: string | null, now: number): string {
  const raw = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO session (id_hash, github_id, created_at, last_seen_at, expires_at, client_name) VALUES (?, ?, ?, ?, ?, ?)").run(
    hashToken(raw),
    githubId,
    iso(now),
    iso(now),
    iso(now + SESSION_TTL_MS),
    clientName,
  );
  return raw;
}

/** Read-only: the session if it exists and has not expired; does not slide it. */
export function peekSession(db: HubDb, rawToken: string, now: number): Session | null {
  const idHash = hashToken(rawToken);
  const row = db.prepare("SELECT github_id, client_name, expires_at FROM session WHERE id_hash = ?").safeIntegers(true).get(idHash) as
    | { github_id: bigint; client_name: string | null; expires_at: string }
    | undefined;
  if (!row || row.expires_at <= iso(now)) return null;
  return { idHash, githubId: row.github_id, clientName: row.client_name, expiresAt: row.expires_at };
}

/** Slides expiry to now + 30d on every hit; null when unknown or expired. */
export function findSession(db: HubDb, rawToken: string, now: number): Session | null {
  const found = peekSession(db, rawToken, now);
  if (!found) return null;
  const idHash = found.idHash;
  const expiresAt = iso(now + SESSION_TTL_MS);
  db.prepare("UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").run(iso(now), expiresAt, idHash);
  return { ...found, expiresAt };
}

export function revokeSession(db: HubDb, idHash: string): void {
  db.prepare("DELETE FROM session WHERE id_hash = ?").run(idHash);
}

export function revokeSessions(db: HubDb, githubId: bigint): void {
  db.prepare("DELETE FROM session WHERE github_id = ?").run(githubId);
}

export type Admission = { ok: true; member: Member; joined: boolean } | { ok: false; reason: "not-invited" | "removed" };

export function isBootstrapped(db: HubDb): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM team").get() as { n: number }).n > 0;
}

/** `ownerLogin` is the only GitHub login that may bootstrap an empty hub; anyone else is refused as not-invited. */
export function bootstrapOrAdmit(db: HubDb, user: GithubIdentity, now: number, ownerLogin: string): Admission {
  return db.transaction((): Admission => {
    const at = iso(now);
    if (!isBootstrapped(db)) {
      if (user.login.toLowerCase() !== ownerLogin.toLowerCase()) return { ok: false, reason: "not-invited" };
      db.prepare("INSERT INTO team (id, name, created_at, owner_github_id) VALUES (?, ?, ?, ?)").run(randomUUID(), `${user.login}'s team`, at, user.id);
      db.prepare("INSERT INTO member (github_id, login, name, avatar_url, role, status, joined_at) VALUES (?, ?, ?, ?, 'OWNER', 'ACTIVE', ?)").run(
        user.id,
        user.login,
        user.name,
        user.avatarUrl,
        at,
      );
      db.prepare("INSERT INTO space (id, kind, name, created_at, created_by) VALUES ('common', 'COMMON', 'Workspace', ?, ?)").run(at, user.id);
      return { ok: true, member: getMember(db, user.id)!, joined: false };
    }
    const existing = getMember(db, user.id);
    if (existing?.status === "ACTIVE") {
      db.prepare("UPDATE member SET login = ?, name = ?, avatar_url = ? WHERE github_id = ?").run(user.login, user.name, user.avatarUrl, user.id);
      return { ok: true, member: getMember(db, user.id)!, joined: false };
    }
    if (existing?.status === "REMOVED") return { ok: false, reason: "removed" };
    type InviteRow = { id: string; role: string; created_by: bigint; created_at: string };
    // An invite bound to this numeric id wins; the login is matched only for legacy rows (github_id NULL) created before invites resolved ids.
    const invite =
      (db
        .prepare("SELECT id, role, created_by, created_at FROM invite WHERE github_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT 1")
        .safeIntegers(true)
        .get(user.id, at) as InviteRow | undefined) ??
      (db
        .prepare("SELECT id, role, created_by, created_at FROM invite WHERE github_id IS NULL AND lower(github_login) = lower(?) AND used_at IS NULL AND expires_at > ? ORDER BY created_at LIMIT 1")
        .safeIntegers(true)
        .get(user.login, at) as InviteRow | undefined);
    if (!invite) return { ok: false, reason: "not-invited" };
    db.prepare("DELETE FROM member WHERE github_id = ?").run(user.id);
    db.prepare("INSERT INTO member (github_id, login, name, avatar_url, role, status, invited_by, invited_at, joined_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)").run(
      user.id,
      user.login,
      user.name,
      user.avatarUrl,
      invite.role,
      invite.created_by,
      invite.created_at,
      at,
    );
    db.prepare("UPDATE invite SET used_at = ? WHERE id = ?").run(at, invite.id);
    return { ok: true, member: getMember(db, user.id)!, joined: true };
  })();
}

export type AuthContext = { db: HubDb; now: () => number; limiter?: Limiter };

/** Member id of the authenticated request, read by the request log. */
export const requestMembers = new WeakMap<IncomingMessage, bigint>();

export const SESSION_LIMIT = 60;
export const SESSION_WINDOW_MS = 10_000;

/** 401 for a missing, malformed, unknown or expired credential; 403 "removed" for removed members. */
export function requireSession(ctx: AuthContext, req: IncomingMessage): Session & { member: Member } {
  const header = req.headers.authorization;
  const m = typeof header === "string" ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(header) : null;
  if (!m) throw new HttpError(401, "unauthorized");
  const session = findSession(ctx.db, m[1], ctx.now());
  if (!session) throw new HttpError(401, "unauthorized");
  const member = getMember(ctx.db, session.githubId);
  if (!member) throw new HttpError(401, "unauthorized");
  if (member.status === "REMOVED") throw new HttpError(403, "removed");
  requestMembers.set(req, member.githubId);
  const taken = ctx.limiter?.take(`session:${session.idHash}`, SESSION_LIMIT, SESSION_WINDOW_MS);
  if (taken && !taken.ok) throw new HttpError(429, "rate limited", { "retry-after": String(taken.retryAfterSec) });
  return { ...session, member };
}
