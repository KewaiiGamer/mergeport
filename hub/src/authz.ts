import type { Member, Role } from "./auth";
import type { HubDb } from "./db";
import { HttpError } from "./http";

const RANK: Record<Role, number> = { READER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export const ROLES = ["READER", "MEMBER", "ADMIN", "OWNER"] as const;

/** Unknown role strings rank below READER, so they never pass. */
export const roleRank = (role: string): number => (role in RANK ? RANK[role as Role] : -1);

/** Throws 403 unless the member's role is at least `min`. */
export function requireRole(member: Pick<Member, "role">, min: Role): void {
  if (roleRank(member.role) < RANK[min]) throw new HttpError(403, "forbidden");
}

export type SpaceAccess = { canRead: boolean; canWrite: boolean };
const NONE: SpaceAccess = { canRead: false, canWrite: false };

/** Role floor: write needs role >= MEMBER even when space_member.can_write = 1. */
export function spaceAccess(db: HubDb, member: Member, spaceId: string): SpaceAccess {
  if (member.status !== "ACTIVE") return NONE;
  const space = db.prepare("SELECT kind FROM space WHERE id = ?").get(spaceId) as { kind: string } | undefined;
  if (!space) return NONE;
  const writer = roleRank(member.role) >= RANK.MEMBER;
  if (space.kind === "COMMON") return { canRead: true, canWrite: writer };
  const row = db.prepare("SELECT can_write FROM space_member WHERE space_id = ? AND github_id = ?").get(spaceId, member.githubId) as { can_write: number } | undefined;
  if (!row) return NONE;
  return { canRead: true, canWrite: row.can_write === 1 && writer };
}

export type SpaceSummary = { id: string; kind: string; name: string; canWrite: boolean; seq: string };

/** Spaces the member can read: COMMON first, then restricted ones by name. */
export function listSpacesFor(db: HubDb, member: Member): SpaceSummary[] {
  if (member.status !== "ACTIVE") return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.name, s.seq, sm.can_write
       FROM space s LEFT JOIN space_member sm ON sm.space_id = s.id AND sm.github_id = ?
       WHERE s.kind = 'COMMON' OR sm.github_id IS NOT NULL
       ORDER BY (s.kind = 'COMMON') DESC, s.name, s.id`,
    )
    .all(member.githubId) as { id: string; kind: string; name: string; seq: number; can_write: number | null }[];
  const writer = roleRank(member.role) >= RANK.MEMBER;
  return rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, seq: String(r.seq), canWrite: writer && (r.kind === "COMMON" || r.can_write === 1) }));
}
