import fs from "node:fs";
import path from "node:path";
import { GITHUB_BACKEND, type Backend } from "@/lib/local/backends";
import { profileDbPath } from "@/lib/local/profile";
import { readActive, writeActive } from "@/lib/local/registry";

/** Which database the launcher opens for the signed-in gh account: the active hub profile if it exists, else the GitHub one. */
export function resolveStartProfile(home: string, host: string, id: bigint): { dbFile: string; backend: Backend } {
  const active = readActive(home);
  const mine = !!active && active.host === host && active.accountId === String(id);
  if (mine && active.backend !== GITHUB_BACKEND) {
    const hub = profileDbPath(home, host, id, active.backend);
    if (fs.existsSync(hub)) return { dbFile: hub, backend: active.backend };
  }
  if (!mine || active.backend !== GITHUB_BACKEND) writeActive(home, { host, accountId: String(id), backend: GITHUB_BACKEND });
  return { dbFile: profileDbPath(home, host, id), backend: GITHUB_BACKEND };
}

/** The database a switch should open; hub profiles are never created here (connecting to the server creates them). */
export function resolveSwitchTarget(home: string, host: string, id: bigint, backend: Backend): { dbFile: string } {
  const dbFile = profileDbPath(home, host, id, backend);
  if (backend !== GITHUB_BACKEND && !fs.existsSync(dbFile)) throw new Error("That server has no profile for this account yet. Connect to it from the sign-in page.");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  return { dbFile };
}
