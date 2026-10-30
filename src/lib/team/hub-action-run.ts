import { run, type ActionResult } from "@/lib/action-result";
import { ValidationError } from "@/lib/errors";
import { HubForbidden, HubRequestError, HubUnauthorized } from "@/lib/hub/ports";
import { isHubBackend } from "@/lib/local/backends";
import { getHubTeamService } from "@/lib/local/runtime";
import { currentBackend } from "@/lib/local/workspaces";

/** The hub service of the active workspace; anything but a hub workspace is refused before a request is made. */
export async function hubService() {
  const backend = await currentBackend();
  if (!isHubBackend(backend)) throw new ValidationError("This workspace is not a team server.");
  return getHubTeamService(backend);
}

/** `run` plus the hub's own failure kinds, worded for a person. Nothing here ever carries a token, a secret or a response body. */
export async function hubRun(fn: () => Promise<ActionResult | void>): Promise<ActionResult> {
  return run(async () => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HubUnauthorized) return { ok: false, error: "Sign in to the server again." };
      if (e instanceof HubForbidden) return { ok: false, error: "You were removed from this team, or the server refused that." };
      if (e instanceof HubRequestError) return { ok: false, error: e.message, retryable: true };
      throw e;
    }
  });
}
