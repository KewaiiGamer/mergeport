/**
 * Encrypted store for the hub session token: one `HubSession` row in the profile database, AES-256-GCM under a random
 * 32-byte key kept in the profile directory (`key`, beside `mergeport.db`).
 *
 * What the key file buys, honestly: it protects the token against accidental disclosure only. Copying the database on its
 * own, a backup of the database alone, or a log or bug report that includes it cannot reveal the token without the key.
 * It does NOT protect against another process running as the same OS user: that process can read both files, exactly
 * as this module does. The upgrade path with real isolation is the operating system keychain (Keychain, Credential
 * Manager, Secret Service), not adopted so far because it needs a native dependency.
 *
 * The key file must stay out of anything that copies or exports a profile; nothing in the project copies profile
 * directories (saved-profiles.ts reads mergeport.db read-only, migrate-from-postgres.ts writes a fresh database).
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@/lib/db";

export type Vault = { encrypt(plain: string): string; decrypt(cipher: string): string };
export type StoredHubSession = { origin: string; token: string; githubId: bigint; login: string };

const ID = "session";

function restrictToCurrentUser(file: string): void {
  if (process.platform !== "win32") return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    // best effort: ACL tightening must never block startup
  }
}

function readKey(keyFile: string): Buffer | null {
  try {
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error(`Hub key file ${keyFile} is corrupt (expected 32 bytes, got ${key.length}); remove it to start over`);
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function loadOrCreateKey(keyFile: string): Buffer {
  const existing = readKey(keyFile);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // Write a private temp file, then hard-link it into place: readers never see a partial key and a racing creator loses with EEXIST.
  const tmp = `${keyFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const key = randomBytes(32);
  try {
    fs.writeFileSync(tmp, key, { mode: 0o600, flag: "wx" });
    restrictToCurrentUser(tmp);
    try {
      fs.linkSync(tmp, keyFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const winner = readKey(keyFile);
      if (!winner) throw e;
      return winner;
    }
    return key;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function openVault(keyFile: string): Vault {
  const key = loadOrCreateKey(keyFile);
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(".");
    },
    decrypt(cipher) {
      const [v, ivB64, tagB64, data] = cipher.split(".");
      if (v !== "v1" || !ivB64 || !tagB64 || data === undefined) throw new Error("bad cipher");
      const iv = Buffer.from(ivB64, "base64");
      const tag = Buffer.from(tagB64, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("bad cipher");
      const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
    },
  };
}

export async function saveHubSession(db: Db, vault: Vault, s: StoredHubSession): Promise<void> {
  const data = { origin: s.origin, cipher: vault.encrypt(s.token), githubId: s.githubId, login: s.login };
  await db.hubSession.upsert({ where: { id: ID }, create: { id: ID, ...data }, update: data });
}

export async function loadHubSession(db: Db, vault: Vault): Promise<StoredHubSession | null> {
  const row = await db.hubSession.findUnique({ where: { id: ID } });
  if (!row) return null;
  try {
    return { origin: row.origin, token: vault.decrypt(row.cipher), githubId: row.githubId, login: row.login };
  } catch {
    return null;
  }
}

export async function clearHubSession(db: Db): Promise<void> {
  await db.hubSession.deleteMany({ where: { id: ID } });
}
