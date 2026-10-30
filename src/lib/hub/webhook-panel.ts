import type { HubWebhooks } from "@/lib/hub/ports";
import { appEvents, appPermissions, stripSlash } from "@/lib/hub/github-app-manifest";

/** Words and values for the "Instant GitHub updates" panel. Pure, so each is unit-tested. */

/** Where a person installs the team's App on their repositories. */
export const installUrl = (appSlug: string) => `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;

export const DAY_MS = 24 * 3600 * 1000;

export type WebhookStatus = { kind: "on" | "waiting" | "quiet" | "off"; text: string };

/** The one status line everyone sees, from `/me.webhooks`. */
export function webhookStatus(w: HubWebhooks, now = Date.now()): WebhookStatus {
  if (!w.enabled) return { kind: "off", text: "Not set up" };
  if (!w.lastDeliveryAt) return { kind: "waiting", text: "Waiting for the first event from GitHub" };
  const t = Date.parse(w.lastDeliveryAt);
  if (Number.isFinite(t) && now - t <= DAY_MS) return { kind: "on", text: "Instant GitHub updates are on" };
  // Set up, and something arrived once, but nothing for a day: not "on", and not "first event" either.
  return { kind: "quiet", text: "No event from GitHub for over a day" };
}

export const WAITING_HELP = "Install the App on a repository (GitHub sends an event when you do), then edit an issue to see it arrive instantly.";
export const UNREACHABLE_HELP = "GitHub could not reach the server. If Cloudflare is in front, add a skip rule for the path /webhooks/github.";

/** `?github-app=failed&reason=<code>` from the callback, as a plain sentence. */
export function appFailureText(reason: string | undefined): string {
  switch (reason) {
    case "state":
      return "That GitHub link was not valid any more. Start again.";
    case "bad-code":
    case "refused":
      return "GitHub did not accept the App. Nothing was saved. Start again.";
    case "network":
      return "Could not reach GitHub. Nothing was saved. Try again.";
    case "bad-answer":
      return "GitHub sent an answer Mergeport could not use. Nothing was saved.";
    case "signin":
      return "Sign in to the server again, then start again.";
    case "owner":
      return "Only the owner of the server can save the App's secret.";
    default:
      return "The App was created on GitHub, but its secret could not be saved on the server. Delete the App on GitHub and start again, or use \"Set it up by hand\".";
  }
}

/** 64 hexadecimal characters (256 bits) from `crypto.getRandomValues`. */
export function generateSecret(c: Pick<Crypto, "getRandomValues"> = crypto): string {
  return Array.from(c.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ByHandValues = {
  appName: string;
  homepageUrl: string;
  webhookUrl: string;
  secret: string;
  permissions: { name: string; access: "Read-only" }[];
  events: string[];
};

/** Everything the by-hand section shows after "Generate". Computed in the browser; nothing leaves it except through "Save secret on the server". */
export function byHandValues(o: { teamName: string; hubOrigin: string; letters: string; secret: string }): ByHandValues {
  const origin = stripSlash(o.hubOrigin);
  return {
    appName: `Mergeport ${o.teamName} ${o.letters}`.replace(/\s+/g, " ").trim(),
    homepageUrl: origin,
    webhookUrl: `${origin}/webhooks/github`,
    secret: o.secret,
    permissions: Object.keys(appPermissions(false)).map((name) => ({ name, access: "Read-only" as const })),
    events: appEvents(false),
  };
}

export const randomLetters = (c: Pick<Crypto, "getRandomValues"> = crypto) => Array.from(c.getRandomValues(new Uint8Array(4)), (b) => String.fromCharCode(97 + (b % 26))).join("");
