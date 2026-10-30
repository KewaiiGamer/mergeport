"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { ValidationError } from "@/lib/errors";
import { HubForbidden, HubRequestError, HubUnauthorized } from "@/lib/hub/ports";
import { isHubBackend } from "@/lib/local/backends";
import { getHubTeamService } from "@/lib/local/runtime";
import { currentBackend } from "@/lib/local/workspaces";

type Role = "ADMIN" | "MEMBER" | "READER";
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Narrows form text to a role; anything else is refused here, before the service (which validates again) is reached. */
function role(fd: FormData, k: string): Role {
  const v = str(fd, k);
  if (v !== "ADMIN" && v !== "MEMBER" && v !== "READER") throw new ValidationError("Choose Admin, Member or Reader.");
  return v;
}

/** Hub team administration. The hub decides who may do what; `HubTeamService` only gives friendlier messages first. */
async function hubService() {
  const backend = await currentBackend();
  if (!isHubBackend(backend)) throw new ValidationError("This workspace is not a team server.");
  return getHubTeamService(backend);
}

/** `run` plus the hub's own failure kinds, worded for a person. Nothing here ever carries a token or a response body. */
async function hubRun(fn: () => Promise<ActionResult | void>): Promise<ActionResult> {
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

export async function hubInviteAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.invite(str(fd, "login"), role(fd, "role"));
    revalidatePath("/team");
    return { ok: true, message: `Invited @${str(fd, "login").replace(/^@/, "")}.` };
  });
}

export async function hubChangeRoleAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.changeRole(str(fd, "githubId"), role(fd, "role"));
    revalidatePath("/team");
    return { ok: true, message: "Role changed." };
  });
}

export async function hubRemoveMemberAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.removeMember(str(fd, "githubId"));
    revalidatePath("/team");
    return { ok: true, message: "Removed from the team." };
  });
}

export async function hubReinstateMemberAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.reinstateMember(str(fd, "githubId"), str(fd, "role"));
    revalidatePath("/team");
    return { ok: true, message: "Reinstated. They sign in to the server again; restricted spaces are granted separately." };
  });
}

export async function hubCreateSpaceAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    // The audience can only name people the hub currently lists as members; anything else in the form is dropped.
    const known = new Set((await svc.overview()).members.filter((m) => m.status !== "REMOVED").map((m) => m.githubId));
    const writers = new Set(fd.getAll("write").map(String));
    const members = [...new Set(fd.getAll("member").map(String))].filter((id) => known.has(id)).map((githubId) => ({ githubId, canWrite: writers.has(githubId) }));
    await svc.createSpace(str(fd, "name"), members);
    revalidatePath("/team");
    return { ok: true, message: "Space created." };
  });
}

export async function hubDeleteSpaceAction(fd: FormData): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc } = await hubService();
    await svc.deleteSpace(str(fd, "spaceId"), { confirmed: str(fd, "confirm") === "on" });
    revalidatePath("/team");
    return { ok: true, message: "Space deleted." };
  });
}

/** Ends the session on the hub and forgets it here. The caller then switches the app back to GitHub. */
export async function hubSignOutAction(): Promise<ActionResult> {
  return hubRun(async () => {
    await requireViewer();
    const { svc, dbFile } = await hubService();
    await svc.signOut(dbFile);
    return { ok: true, data: { switchTo: "github" } };
  });
}
