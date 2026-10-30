import type { HubDb } from "./db";

export const SECRET_KEY = "github_webhook_secret";
export const SLUG_KEY = "github_app_slug";

export function getSetting(db: HubDb, key: string): string | null {
  const r = db.prepare("SELECT value FROM setting WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setSetting(db: HubDb, key: string, value: string): void {
  db.prepare("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function deleteSetting(db: HubDb, key: string): void {
  db.prepare("DELETE FROM setting WHERE key = ?").run(key);
}

export type WebhookStatus = { enabled: boolean; appSlug: string | null; lastDeliveryAt: string | null; lastEvent: string | null };

/** The webhook secret (table first, env fallback second), cached in memory, and the in-memory record of the last delivery. */
export type WebhookState = {
  secret(): string | null;
  set(secret: string, appSlug: string | null): void;
  clear(): void;
  record(event: string, at: number): void;
  status(): WebhookStatus;
};

export function createWebhookState(db: HubDb, envSecret: string | undefined): WebhookState {
  let cached: { value: string | null } | null = null;
  let last: { at: string; event: string } | null = null;
  const secret = (): string | null => (cached ??= { value: getSetting(db, SECRET_KEY) }).value ?? (envSecret || null);
  return {
    secret,
    set(value, appSlug) {
      db.transaction(() => {
        setSetting(db, SECRET_KEY, value);
        if (appSlug) setSetting(db, SLUG_KEY, appSlug);
        else deleteSetting(db, SLUG_KEY);
      })();
      cached = { value };
    },
    clear() {
      db.transaction(() => {
        deleteSetting(db, SECRET_KEY);
        deleteSetting(db, SLUG_KEY);
      })();
      cached = { value: null };
    },
    record(event, at) {
      last = { at: new Date(at).toISOString(), event };
    },
    status() {
      return { enabled: secret() !== null, appSlug: getSetting(db, SLUG_KEY), lastDeliveryAt: last?.at ?? null, lastEvent: last?.event ?? null };
    },
  };
}
