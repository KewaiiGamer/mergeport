import { createHash } from "node:crypto";
import { ValidationError } from "@/lib/errors";

/** Where a profile's data lives: GitHub itself, or one hub server identified by a fingerprint of its origin. */
export type Backend = "github" | `hub-${string}`;
export const GITHUB_BACKEND = "github" as const;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** One canonical origin per server, so the same hub typed differently always gets the same fingerprint. */
export function normalizeHubOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ValidationError("That is not a valid server address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ValidationError("A server address must start with https://.");
  if (u.username || u.password) throw new ValidationError("A server address must not contain a username or password.");
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname)) throw new ValidationError("Plain http:// is only allowed for a server on this computer. Use https://.");
  return u.origin;
}

export const hubBackendId = (origin: string): Backend => `hub-${createHash("sha256").update(normalizeHubOrigin(origin)).digest("hex").slice(0, 16)}`;
export const isHubBackend = (b: string): b is `hub-${string}` => /^hub-[0-9a-f]{16}$/.test(b);
