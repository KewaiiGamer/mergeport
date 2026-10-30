import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { profileDirName } from "@/lib/local/profile";

export type SavedProfile = { id: bigint; login: string; dbFile: string };

/** Profiles already on this computer for a host, read without touching them (read-only, no migration, no network). */
export function savedProfiles(home: string, host: string): SavedProfile[] {
  const root = path.join(home, "profiles");
  const prefix = profileDirName(host, 0n).replace(/0$/, "");
  let dirs: string[] = [];
  try {
    // Hub profiles sit beside these as `<host>-<id>-hub-<fp>`; only plain `<host>-<id>` is a GitHub profile.
    const own = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`);
    dirs = fs.readdirSync(root).filter((d) => own.test(d));
  } catch {
    return [];
  }
  const out: SavedProfile[] = [];
  for (const d of dirs) {
    const dbFile = path.join(root, d, "mergeport.db");
    if (!fs.existsSync(dbFile)) continue;
    try {
      const db = new Database(dbFile, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare("select githubId, login from User where isDemo = 0 order by createdAt limit 1").get() as { githubId: number | bigint; login: string } | undefined;
        if (row) out.push({ id: BigInt(row.githubId), login: row.login, dbFile });
      } finally {
        db.close();
      }
    } catch {
      /* unreadable or foreign file: not a usable profile */
    }
  }
  return out;
}

/** True when `gh api user` failed for want of a network, as opposed to being signed out or refused. */
export const looksOffline = (message: string) => /connect|network|internet|ENOTFOUND|ETIMEDOUT|ECONN|timed? ?out|unreachable/i.test(message) && !/HTTP 401|bad credentials|not logged in/i.test(message);
