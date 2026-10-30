import type { Db } from "@/lib/db";
import { COVERAGE_KEY } from "@/lib/hub/webhook-panel";

/**
 * Stops using the current team on THIS computer: spaces are forgotten, shared repositories and projects become local again,
 * and the profile returns to personal mode. It writes nothing to GitHub (the repositories, invitations and collaborators stay as
 * they are; remove those on GitHub). Local data (cards, rules, boards) is kept; unsent edits to shared records are dropped
 * with their space. Afterwards a new team can be created or joined.
 */
export async function leaveTeamLocally(db: Db): Promise<{ spaces: number }> {
  const spaces = await db.space.count();
  await db.$transaction([
    db.repository.updateMany({ where: { spaceId: { not: null } }, data: { spaceId: null } }),
    db.project.updateMany({ where: { spaceId: { not: null } }, data: { spaceId: null } }),
    db.space.deleteMany({}),
    db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "PERSONAL" }, update: { mode: "PERSONAL", teamRemoteId: null, name: null, ownerLogin: null, commonSpaceId: null } }),
    db.discoveryCache.deleteMany({ where: { OR: [{ key: { startsWith: "inv-status:" } }, { key: { in: ["invitations", "candidates", COVERAGE_KEY] } }] } }),
  ]);
  return { spaces };
}
