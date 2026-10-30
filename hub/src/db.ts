import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../src/lib/db/migrate";

const here = path.dirname(fileURLToPath(import.meta.url));

export type HubDb = Database.Database;

export function openHubDb(dataDir: string): HubDb {
  const file = path.join(dataDir, "hub.db");
  applyMigrations(file, path.resolve(here, "../migrations"));
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
