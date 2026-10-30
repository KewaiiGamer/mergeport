import { randomBytes } from "node:crypto";

/**
 * Device sign-ins this local app has started with a hub, kept in this process's memory. The browser only ever holds an
 * opaque poll id: the hub's device code and poll secret never leave the server side of the local app, so a page that can
 * read the browser's network traffic cannot collect the session from the hub itself.
 */
export type DeviceFlow = { origin: string; deviceCode: string; pollSecret: string; expiresAt: number };

const flows = new Map<string, DeviceFlow>();

const sweep = (now: number) => {
  for (const [k, f] of flows) if (f.expiresAt <= now) flows.delete(k);
};

export function rememberDeviceFlow(f: DeviceFlow, now = Date.now()): string {
  sweep(now);
  const pollId = randomBytes(16).toString("base64url");
  flows.set(pollId, f);
  return pollId;
}

export function deviceFlow(pollId: string, now = Date.now()): DeviceFlow | null {
  sweep(now);
  return flows.get(pollId) ?? null;
}

export function forgetDeviceFlow(pollId: string): void {
  flows.delete(pollId);
}

export function resetDeviceFlows(): void {
  flows.clear();
}
