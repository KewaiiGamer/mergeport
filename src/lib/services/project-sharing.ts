import type { Db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

/** The space a "share with the team" checkbox means: the team's common space, provided this person can write to it. */
export async function commonSpaceIdForSharing(db: Db): Promise<string> {
  const s = await db.space.findFirst({ where: { kind: "COMMON", access: "OK", canWrite: true } });
  if (!s) throw new ValidationError("There is no team space you can write to, so the project can only stay on this computer.");
  return s.id;
}
