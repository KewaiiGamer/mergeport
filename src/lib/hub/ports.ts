import type { Backend } from "@/lib/local/backends";

/**
 * The seam between the hub profile UI and the hub storage/sync layer. `ports-impl.ts` implements it; callers only
 * depend on these types.
 */
export type HubSessionPort = {
  // stores the token encrypted in the profile db (HubSession table + key file)
  save(dbFile: string, s: { origin: string; token: string; githubId: string; login: string }): Promise<void>;
  // marks TeamConfig as a TEAM profile on the HUB backend at `origin`
  markProfile(dbFile: string, p: { backend: Backend; origin: string; teamName: string }): Promise<void>;
  // the stored session, or null when there is none (decrypts the HubSession row)
  read(dbFile: string): Promise<{ origin: string; token: string; githubId: string } | null>;
  // forgets the stored session (sign out); a missing session is not an error
  remove(dbFile: string): Promise<void>;
};

export type HubLinkStatus = { state: "live" | "reconnecting" | "offline"; pendingOps: number; needsSignIn: boolean };

export type HubRole = "OWNER" | "ADMIN" | "MEMBER" | "READER";
export type HubMember = { githubId: string; login: string; name: string | null; avatarUrl: string | null; role: HubRole; status: "INVITED" | "ACTIVE" | "REMOVED" };
export type HubSpaceInfo = { id: string; kind: "COMMON" | "RESTRICTED"; name: string; canWrite: boolean; seq: string };
export type HubSpaceMember = { githubId: string; canWrite: boolean };
export type HubAdminSpace = { id: string; kind: "COMMON" | "RESTRICTED"; name: string; members: HubSpaceMember[] };

/** `/me.webhooks`: whether the hub holds a GitHub App webhook secret, and what it last received (event name only, never content). */
export type HubWebhooks = { enabled: boolean; appSlug: string | null; lastDeliveryAt: string | null; lastEvent: string | null };

/** Admin calls against the hub. The hub decides who may do what; callers only get friendlier errors. */
export type HubAdminApi = {
  me(): Promise<{ member: HubMember; team: { name: string }; members: HubMember[]; spaces: HubSpaceInfo[]; webhooks: HubWebhooks }>;
  invite(login: string, role: "ADMIN" | "MEMBER" | "READER"): Promise<void>;
  removeMember(githubId: string): Promise<void>;
  /** OWNER only: removed members, who /me no longer lists. */
  removedMembers(): Promise<HubMember[]>;
  /** OWNER only: gives a removed member access again, as `role`, in the common space only. */
  reinstateMember(githubId: string, role: "ADMIN" | "MEMBER" | "READER"): Promise<void>;
  setRole(githubId: string, role: "ADMIN" | "MEMBER" | "READER"): Promise<void>;
  /** ADMIN+ only: every space with its members. */
  adminSpaces(): Promise<HubAdminSpace[]>;
  createSpace(name: string, members: HubSpaceMember[]): Promise<HubSpaceInfo>;
  updateSpace(id: string, p: { name?: string; members?: HubSpaceMember[] }): Promise<void>;
  deleteSpace(id: string): Promise<void>;
  /** OWNER only: stores the GitHub App's webhook secret (and its slug, when known) on the hub. The hub never returns the secret. */
  setGithubWebhook(secret: string, appSlug?: string | null): Promise<void>;
  /** OWNER only: removes the secret and slug; the hub's webhook endpoint answers 404 again. */
  clearGithubWebhook(): Promise<void>;
  logout(): Promise<void>;
};

/** 401: no valid session; the user signs in to the server again. */
export class HubUnauthorized extends Error {
  constructor(message = "Sign in to the server again") {
    super(message);
    this.name = "HubUnauthorized";
  }
}
/** 403: the hub refused this member. */
export class HubForbidden extends Error {
  constructor(message = "The server refused that") {
    super(message);
    this.name = "HubForbidden";
  }
}
/** 429 or other non-success answers. `retryAfter` is the Retry-After header value when present. */
export class HubRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: string | null = null) {
    super(message);
    this.name = "HubRequestError";
  }
}
