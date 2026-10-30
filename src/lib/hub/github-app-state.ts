import { randomBytes } from "node:crypto";

/**
 * The single-use `state` of one "Create the GitHub App" attempt, kept in this process's memory (like the device flows).
 * GitHub echoes it back to the callback; it is the only thing that ties the callback to a start the owner pressed here.
 * It expires after 15 minutes and works once.
 */
export const APP_STATE_TTL_MS = 15 * 60_000;

export type AppStateEntry = { hubOrigin: string; expiresAt: number };
export type Clock = () => number;

const states = new Map<string, AppStateEntry>();

const sweep = (now: number) => {
  for (const [k, e] of states) if (e.expiresAt <= now) states.delete(k);
};

export function rememberAppState(hubOrigin: string, now: Clock = Date.now): string {
  sweep(now());
  const state = randomBytes(32).toString("base64url");
  states.set(state, { hubOrigin, expiresAt: now() + APP_STATE_TTL_MS });
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
