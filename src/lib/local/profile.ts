import path from "node:path";
import type { Db } from "@/lib/db";
import type { Backend } from "@/lib/local/backends";

/**
 * A local profile = one SQLite file for one (host, GitHub account id). Credentials, caches and pending edits are
 * namespaced by that pair, so switching accounts can never mix data: a different account gets a different file.
 */

export type LocalIdentity = { id: bigint; login: string; name: string | null; avatarUrl: string | null; host: string };

export class AccountMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`This profile belongs to GitHub account ${expected}, but gh is signed in as ${actual}. Switch back with gh auth switch, or start Mergeport for the other account.`);
  }
}

export const mergeportHome = (override?: string) => override ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".mergeport");
/** GitHub profiles keep their original folder name; a hub profile is the same name plus `-hub-<fingerprint>`. */
export const profileDirName = (host: string, accountId: bigint, backend: Backend = "github") => {
  const base = `${host.replace(/[^a-z0-9.-]/gi, "_")}-${accountId}`;
  return backend === "github" ? base : `${base}-${backend}`;
};
export const profileDbPath = (home: string, host: string, accountId: bigint, backend: Backend = "github") => path.join(home, "profiles", profileDirName(host, accountId, backend), "mergeport.db");

/** Creates the single local workspace, user and member for this profile, or verifies the stored one matches. */
export async function ensureLocalProfile(db: Db, who: LocalIdentity) {
  const existing = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  if (existing && existing.githubId !== who.id) throw new AccountMismatchError(existing.login, who.login);
  const workspace = (await db.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await db.workspace.create({ data: { name: "Personal workspace" } }));
  const user = await db.user.upsert({ where: { githubId: who.id }, create: { githubId: who.id, login: who.login, name: who.name, avatarUrl: who.avatarUrl }, update: { login: who.login, name: who.name, avatarUrl: who.avatarUrl } });
  const member = await db.member.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, create: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" }, update: { status: "ACTIVE" } });
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "PERSONAL" }, update: {} });
  return { workspace, user, member };
}
