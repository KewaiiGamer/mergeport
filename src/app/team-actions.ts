"use server";

import { leaveTeamLocally } from "@/lib/team/leave";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { ValidationError } from "@/lib/errors";
import { getEngine, getTeamService } from "@/lib/local/runtime";
import { shareRepositoryToSpace, unshareRepository } from "@/lib/services/repositories";
import { assertSameAudience } from "@/lib/services/planning";
import { audit } from "@/lib/services/audit";
import { KEY_CANDIDATES, startDiscovery } from "@/lib/local/discovery-jobs";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const checked = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

async function team() {
  const t = await getTeamService();
  if (!t) throw new ValidationError("GitHub sign-in is not available in demo mode. Run npm run local to use teams.");
  return t;
}
async function engine() {
  const e = await getEngine();
  if (!e) throw new ValidationError("Sync is not available in demo mode.");
  return e;
}

/** Step 2 of team creation. Step 1 (the plan) is rendered by the page; nothing is created without this explicit confirmation. */
export async function createTeamAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const t = await team();
    const plan = await t.planTeam({ name: str(fd, "name"), owner: str(fd, "owner") || undefined });
    if (plan.fullName !== str(fd, "expected")) throw new ValidationError("The proposed repository changed. Review the new plan and confirm again.");
    const space = await t.createTeam(plan, { confirmed: checked(fd, "confirm") });
    await audit(db, viewer, "team.create", { type: "Space", id: space.id }, { repo: plan.fullName });
    revalidatePath("/team");
    return { ok: true, message: `Created private repository ${plan.fullName}. You are its administrator.` };
  });
}

export async function leaveTeamAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    if (!checked(fd, "confirm")) throw new ValidationError("Confirm that this computer should stop using the team");
    const { spaces } = await leaveTeamLocally(db);
    revalidatePath("/team");
    revalidatePath("/repositories");
    revalidatePath("/admin/projects");
    return { ok: true, message: `This computer no longer uses the team (${spaces} space${spaces === 1 ? "" : "s"} forgotten). Nothing was changed on GitHub.` };
  });
}

export async function createSpaceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const t = await team();
    if (!checked(fd, "confirm")) throw new ValidationError("Confirm that a new private repository will be created");
    const space = await t.createRestrictedSpace({ name: str(fd, "name") });
    revalidatePath("/team");
    return { ok: true, message: `Created private repository ${space.repoOwner}/${space.repoName}. Invite the people who should see this space.` };
  });
}

export async function inviteAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const t = await team();
    const space = await db.space.findUniqueOrThrow({ where: { id: str(fd, "spaceId") } });
    const plan = t.planInvite(space, str(fd, "usernames").split(/[,\s]+/), str(fd, "permission") === "pull" ? "pull" : "push");
    const out = await t.invite(space, plan, { confirmed: checked(fd, "confirm") });
    revalidatePath("/team");
    const ok = out.filter((o) => o.state !== "failed").length;
    const failed = out.filter((o) => o.state === "failed");
    if (ok === 0) return { ok: false, error: failed.map((f) => `${f.username}: ${f.error}`).join("; ") };
    return { ok: true, message: `${ok} invitation(s) sent through GitHub.${failed.length ? ` Failed: ${failed.map((f) => `${f.username} (${f.error})`).join(", ")}.` : ""}` };
  });
}

export async function revokeAccessAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const t = await team();
    const space = await db.space.findUniqueOrThrow({ where: { id: str(fd, "spaceId") } });
    await t.revokeInvitationOrAccess(space, str(fd, "username"));
    revalidatePath("/team");
    return { ok: true, message: "Invitation or access removed on GitHub. Anything already downloaded stays downloaded." };
  });
}

export async function acceptGithubInvitationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const t = await team();
    await t.acceptInvitation(Number(str(fd, "id")));
    revalidatePath("/team");
    return { ok: true, message: "Invitation accepted on GitHub. Now join the space." };
  });
}

export async function joinSpaceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const t = await team();
    if (!checked(fd, "confirm")) throw new ValidationError("Tick the box to confirm you have reviewed what joining downloads and publishes");
    const repoId = Number(str(fd, "repoId"));
    const space = await t.join(str(fd, "repo"), { confirmed: true, expectedRepoId: Number.isInteger(repoId) && repoId > 0 ? repoId : undefined });
    // Syncing starts in the background: joining must not wait on a slow network.
    void (await engine()).syncSpace(space).catch(() => {});
    startDiscovery(KEY_CANDIDATES);
    revalidatePath("/", "layout");
    return { ok: true, message: `Joined “${space.name}”. Shared data is loading in the background.` };
  });
}

/** Asks for a background refresh of one cached discovery list. Returns at once; the page shows the cached list and its freshness. */
export async function refreshDiscoveryAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { user } = await requireViewer();
    const key = str(fd, "key");
    if (!(["repos", "invitations", "candidates"].includes(key) || /^inv-status:[A-Za-z0-9_-]{1,40}$/.test(key))) throw new ValidationError("Unknown list");
    startDiscovery(key, user.login);
    return { ok: true, message: "Checking GitHub in the background. The saved list stays until the new one arrives." };
  });
}

export async function refreshSyncAction(): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    await (await engine()).refreshNow();
    revalidatePath("/", "layout");
    return { ok: true, message: "Refreshed" };
  });
}

export async function resolveConflictAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const choice = str(fd, "choice") === "theirs" ? "theirs" : "mine";
    await (await engine()).resolveConflict(str(fd, "id"), choice);
    revalidatePath("/sync");
    return { ok: true, message: choice === "mine" ? "Kept your version. It will be sent on the next sync." : "Took the teammate's version." };
  });
}

export async function releaseQuarantineAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    await (await engine()).releaseQuarantine(str(fd, "spaceId"), str(fd, "action") === "retry" ? "retry" : "discard");
    revalidatePath("/sync");
    return { ok: true, message: "Done" };
  });
}

export async function resendRestoredAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const { queued } = await (await engine()).resendRestored(str(fd, "id"));
    revalidatePath("/sync");
    return { ok: true, message: queued ? `${queued} item(s) queued to send to the server again` : "Nothing to send: those items were changed since." };
  });
}

export async function dismissRestoredAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    await (await engine()).dismissRestored(str(fd, "id"));
    revalidatePath("/sync");
    return { ok: true, message: "Dismissed" };
  });
}

export async function setPollSecondsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const n = Math.max(15, Math.min(600, Number(str(fd, "seconds")) || 30));
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", pollSeconds: n }, update: { pollSeconds: n } });
    revalidatePath("/sync");
    return { ok: true, message: `Active polling every ${n} seconds` };
  });
}

export async function shareRepositoryAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!checked(fd, "confirm")) throw new ValidationError("Confirm who will see this repository");
    await shareRepositoryToSpace(db, viewer, str(fd, "repositoryId"), str(fd, "spaceId"));
    revalidatePath("/repositories");
    return { ok: true, message: "Shared. It will appear for everyone with access to that space on their next poll." };
  });
}

export async function unshareRepositoryAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await unshareRepository(db, viewer, str(fd, "repositoryId"));
    revalidatePath("/repositories");
    return { ok: true, message: "No longer shared" };
  });
}

export async function setProjectSpaceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const projectId = str(fd, "projectId");
    const spaceId = str(fd, "spaceId") || null;
    const p = await db.project.findFirst({ where: { id: projectId, workspaceId: viewer.workspaceId } });
    if (!p) throw new ValidationError("Unknown project");
    if (spaceId) {
      const s = await db.space.findUnique({ where: { id: spaceId } });
      if (!s?.canWrite || s.access !== "OK") throw new ValidationError("You need write access to that space");
      const linked = (await db.projectRepository.findMany({ where: { projectId } })).map((l) => l.repositoryId);
      await assertSameAudience(db, spaceId, linked);
    }
    await db.project.update({ where: { id: projectId }, data: { spaceId } });
    revalidatePath("/admin/projects");
    return { ok: true, message: spaceId ? "Project and its cards are now shared through that space." : "Project is local again." };
  });
}
