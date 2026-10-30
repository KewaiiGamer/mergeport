import fs from "node:fs";
import path from "node:path";
import { isHubBackend, type Backend } from "@/lib/local/backends";

/** Which profile the launcher opens, and which hub servers this computer knows. Never holds tokens or sessions. */
export type Active = { host: string; accountId: string; backend: Backend };
export type HubEntry = { origin: string; teamName: string; lastSignedInAs: { id: string; login: string }; addedAt: string };

const activeFile = (home: string) => path.join(home, "active.json");
const hubsFile = (home: string) => path.join(home, "hubs.json");

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Temp file then rename, so a crash never leaves half a file behind. */
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBackend = (v: unknown): v is Backend => v === "github" || (typeof v === "string" && isHubBackend(v));

export function readActive(home: string): Active | null {
  const j = readJson(activeFile(home)) as Partial<Active> | null;
  if (!j || typeof j !== "object" || !isStr(j.host) || !isStr(j.accountId) || !isBackend(j.backend)) return null;
  return { host: j.host, accountId: j.accountId, backend: j.backend };
}

export function writeActive(home: string, a: Active): void {
  writeJson(activeFile(home), { host: a.host, accountId: a.accountId, backend: a.backend });
}

function isHubEntry(e: unknown): e is HubEntry {
  const x = e as HubEntry | null;
  return !!x && typeof x === "object" && isStr(x.origin) && typeof x.teamName === "string" && isStr(x.addedAt) && !!x.lastSignedInAs && isStr(x.lastSignedInAs.id) && typeof x.lastSignedInAs.login === "string";
}

export function readHubs(home: string): HubEntry[] {
  const j = readJson(hubsFile(home));
  return Array.isArray(j) ? j.filter(isHubEntry).map((e) => ({ origin: e.origin, teamName: e.teamName, lastSignedInAs: { id: e.lastSignedInAs.id, login: e.lastSignedInAs.login }, addedAt: e.addedAt })) : [];
}

export function upsertHub(home: string, e: HubEntry): void {
  const rest = readHubs(home).filter((h) => h.origin !== e.origin);
  writeJson(hubsFile(home), [...rest, e]);
}

export function removeHub(home: string, origin: string): void {
  writeJson(hubsFile(home), readHubs(home).filter((h) => h.origin !== origin));
}
