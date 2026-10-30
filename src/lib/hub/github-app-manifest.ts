/**
 * The GitHub App manifest the Team page posts to github.com (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 * Pure: everything it needs is passed in, so it is unit-tested without a server.
 */

export type ManifestOptions = {
  teamName: string;
  /** The hub's origin, e.g. `https://hub.example.com` (no trailing slash needed). */
  hubOrigin: string;
  /** This app's own port: GitHub redirects the browser back to `http://127.0.0.1:<port>/api/local/hub/github-app/callback`. */
  port: number;
  /** `public: true` lets teammates install the App on their own repositories (a private App is installable only by its creator's account). */
  teammates: boolean;
  /** Adds `contents: read` and the `push`, `create`, `delete` events, so branches and commits refresh instantly too. */
  contents: boolean;
  /** Four random lowercase letters in the name keep it unique on GitHub. Injectable for tests. */
  randomLetters?: () => string;
};

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  request_oauth_on_install: boolean;
  default_permissions: Record<string, "read">;
  default_events: string[];
};

export const CALLBACK_PATH = "/api/local/hub/github-app/callback";

const BASE_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_run", "check_suite", "status"];
const CONTENT_EVENTS = ["push", "create", "delete"];
const BASE_PERMISSIONS = ["issues", "pull_requests", "checks", "statuses", "metadata"];

/** Permissions and events as the by-hand section lists them (same source as the manifest, so the two cannot drift). */
export const appPermissions = (contents: boolean): Record<string, "read"> => Object.fromEntries([...BASE_PERMISSIONS, ...(contents ? ["contents"] : [])].map((p) => [p, "read" as const]));
export const appEvents = (contents: boolean): string[] => [...BASE_EVENTS, ...(contents ? CONTENT_EVENTS : [])];

const defaultLetters = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => String.fromCharCode(97 + (b % 26))).join("");
};

export const stripSlash = (origin: string) => origin.replace(/\/+$/, "");

export function buildManifest(o: ManifestOptions): GithubAppManifest {
  const origin = stripSlash(o.hubOrigin);
  return {
    name: `Mergeport ${o.teamName} ${(o.randomLetters ?? defaultLetters)()}`.replace(/\s+/g, " ").trim(),
    url: origin,
    hook_attributes: { url: `${origin}/webhooks/github`, active: true },
    redirect_url: `http://127.0.0.1:${o.port}${CALLBACK_PATH}`,
    public: o.teammates,
    request_oauth_on_install: false,
    default_permissions: appPermissions(o.contents),
    default_events: appEvents(o.contents),
  };
}

/** `https://github.com/settings/apps/new?state=...` for a personal account, `.../organizations/<org>/settings/apps/new?state=...` for an organisation. */
export function manifestActionUrl(account: { kind: "personal" } | { kind: "org"; org: string }, state: string): string {
  const q = `?state=${encodeURIComponent(state)}`;
  return account.kind === "personal" ? `https://github.com/settings/apps/new${q}` : `https://github.com/organizations/${encodeURIComponent(account.org)}/settings/apps/new${q}`;
}

/** A GitHub organisation login: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
