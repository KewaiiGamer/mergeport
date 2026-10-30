import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The single-use `state` of one "Create the GitHub App" attempt, kept in this process's memory (like the device flows).
 * GitHub echoes it back to the callback; it is the only thing that ties the callback to a start the owner pressed here.
 * It expires after 15 minutes and works once.
 */
export const APP_STATE_TTL_MS = 15 * 60_000;

export type AppStateEntry = { hubOrigin: string; memberId: string; nonce: string; expiresAt: number };
export type Clock = () => number;

const states = new Map<string, AppStateEntry>();

const sweep = (now: number) => {
  for (const [k, e] of states) if (e.expiresAt <= now) states.delete(k);
};

export function rememberAppState(hubOrigin: string, memberId: string, nonce: string, now: Clock = Date.now): string {
  sweep(now());
  const state = randomBytes(32).toString("base64url");
  states.set(state, { hubOrigin, memberId, nonce, expiresAt: now() + APP_STATE_TTL_MS });
  return state;
}

/** Removes the state whatever the outcome: a callback that fails later still cannot be replayed. Returns it only while unexpired. */
export function consumeAppState(state: string, now: Clock = Date.now): AppStateEntry | null {
  sweep(now());
  const e = states.get(state);
  if (!e) return null;
  states.delete(state);
  return e.expiresAt > now() ? e : null;
}

export function resetAppStates(): void {
  states.clear();
}

/**
 * The state is also bound to the browser that pressed the button: `start` sets this cookie (HttpOnly, SameSite=Lax so it is sent
 * on the top-level GET navigation back from github.com) and keeps the same value in the state entry; `callback` must present it.
 */
export const APP_NONCE_COOKIE = "mp_gh_app";
export const APP_COOKIE_PATH = "/api/local/hub/github-app/";
export const newNonce = () => randomBytes(32).toString("base64url");

export function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sameNonce(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
