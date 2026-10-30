import type { Backend } from "@/lib/local/backends";
import { isHubBackend } from "@/lib/local/backends";
import { ValidationError } from "@/lib/errors";

// Engine integration: when plan 2 merges, call assertBackendMatch(config, space) once where a space is opened.

/** A workspace of one backend type must never be read or written through the other. */
export function assertBackendMatch(config: { backend: Backend }, space: { backend: "GITHUB" | "HUB" }): void {
  const ok = space.backend === "GITHUB" ? config.backend === "github" : isHubBackend(config.backend);
  if (!ok) throw new ValidationError("This workspace belongs to a different kind of connection.");
}
