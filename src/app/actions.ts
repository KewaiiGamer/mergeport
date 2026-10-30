"use server";

import { commonSpaceIdForSharing } from "@/lib/services/project-sharing";
import { applyAutoSetup } from "@/lib/services/auto-setup";
import { setProjectReviewers } from "@/lib/services/project-reviewers";
import { notifyChange } from "@/lib/local/runtime";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { run, type ActionResult } from "@/lib/action-result";
import { requireAdminViewer, requireViewer } from "@/lib/auth/current";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { requireAdmin, requireRepo } from "@/lib/authz/viewer";
import { removeFromTracking, trackLocally, upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import * as work from "@/lib/services/work-actions";
import { addDependency, assertSameAudience, createCard, moveCard, requestManualReview, resolveManualReview, createColumnsForProject } from "@/lib/services/planning";
import { mapLocalRoot, scanWorktrees, unmapLocalRoot } from "@/lib/services/worktrees";
import { audit } from "@/lib/services/audit";
import { publicPort } from "@/lib/github/factory";
import { readCached } from "@/lib/local/discovery";
import type { Discovery } from "@/lib/github/port";
import { GithubError } from "@/lib/github/port";
import { enqueue } from "@/lib/jobs";
import { slugify } from "@/lib/slug";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const strs = (fd: FormData, k: string) => fd.getAll(k).map(String).filter(Boolean);
const csv = (v: string) => v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

// ---------- repositories (tracked locally; sharing is a separate, explicit step) ----------

const urlRe = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** Public import via the official public REST API, with no credential at all. Nothing is shared with teammates. */
export async function importPublicAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const m = urlRe.exec(str(fd, "repo"));
    if (!m) throw new ValidationError("Enter a GitHub URL or owner/repo");
    const meta = await publicPort(db).getRepository(m[1], m[2]).catch((e) => {
      if (e instanceof GithubError && e.kind === "not-found") throw new ValidationError("That repository is not public, or does not exist. Private repositories use Connect repositories.");
      throw e;
    });
    if (meta.visibility !== "PUBLIC") throw new ValidationError("Only public repositories can be imported by URL");
    const [r] = await trackLocally(db, viewer, [meta]);
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id, full: true }, dedupeKey: `sync:${r.id}` });
    revalidatePath("/repositories");
    return { ok: true, message: `${meta.fullName} is tracked on this computer. It is not shared with teammates.` };
  });
}

/** Tracks repositories the person's own GitHub access can list. Tracking is local; it neither grants GitHub access nor publishes anything. */
export async function trackSelectedAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const ids = new Set(strs(fd, "repo"));
    if (ids.size === 0) throw new ValidationError("Select at least one repository");
    // Selected from the saved list: no live GitHub call, so this works offline and never waits on a stalled CLI.
    const saved = await readCached<Discovery>(db, "repos");
    if (!saved.payload) throw new ValidationError("The repository list has not been loaded yet. Use Check again, then select.");
    const found = saved.payload.repos.filter((r) => ids.has(r.githubId.toString()));
    if (found.length !== ids.size) throw new ValidationError("Some selected repositories are no longer available to your GitHub account");
    const rows = await trackLocally(db, viewer, found);
    for (const r of rows) await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id, full: true }, dedupeKey: `sync:${r.id}` });
    notifyChange("state");
    revalidatePath("/repositories");
    return { ok: true, message: `${found.length} repositor${found.length === 1 ? "y is" : "ies are"} tracked on this computer. Nothing was shared.` };
  });
}

export async function untrackRepositoryAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await removeFromTracking(db, viewer, str(fd, "repositoryId"));
    revalidatePath("/repositories");
    return { ok: true, message: "Repository removed from tracking. Nothing was deleted on GitHub." };
  });
}

export async function refreshRepositoryAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const repo = await requireRepo(db, viewer, str(fd, "repositoryId"));
    // A person asking for a refresh gets a complete one: every page is listed again (unchanged items cost no detail requests), so a
    // repository whose earlier sync was cut short is repaired instead of only receiving what changed since.
    await enqueue(db, { type: "sync.repository", payload: { repositoryId: repo.id, full: true }, dedupeKey: `sync:${repo.id}` });
    notifyChange("state"); // the top bar shows the queued refresh at once
    return { ok: true, message: "Refresh queued. The worker will update this repository shortly." };
  });
}

// ---------- GitHub work actions ----------

const ctx = async () => ({ db, v: (await requireViewer()).viewer });

export async function commentAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await work.addComment(await ctx(), str(fd, "id"), String(fd.get("body") ?? ""));
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Comment posted" };
  });
}

export async function inlineCommentAction(input: { id: string; path: string; line: number; side: "LEFT" | "RIGHT"; body: string }): Promise<ActionResult> {
  return run(async () => {
    await work.addReviewComment(await ctx(), input.id, { path: input.path, line: input.line, side: input.side === "LEFT" ? "LEFT" : "RIGHT", body: input.body });
    revalidatePath("/pull-requests/" + input.id);
    return { ok: true, message: "Comment posted" };
  });
}

export async function labelsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await work.setLabels(await ctx(), str(fd, "id"), str(fd, "labels").split(",").map((s) => s.trim()));
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Labels updated" };
  });
}

export async function assigneesAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await work.setAssignees(await ctx(), str(fd, "id"), csv(str(fd, "assignees")));
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Assignees updated" };
  });
}

export async function milestoneAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const n = str(fd, "number");
    await work.setRepoMilestone(await ctx(), str(fd, "id"), n ? Number(n) : null);
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Milestone updated" };
  });
}

export async function requestReviewAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await work.requestReview(await ctx(), str(fd, "id"), csv(str(fd, "users")), csv(str(fd, "teams")));
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Review requested on GitHub" };
  });
}

export async function submitReviewAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const event = z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]).parse(str(fd, "event"));
    await work.submitReview(await ctx(), str(fd, "id"), event, String(fd.get("body") ?? ""));
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Review submitted" };
  });
}

export async function createIssueAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const c = await ctx();
    const created = await work.createIssue(c, str(fd, "repositoryId"), { title: str(fd, "title"), body: String(fd.get("body") ?? ""), labels: csv(str(fd, "labels")) });
    revalidatePath("/issues");
    return { ok: true, message: `Issue #${created.number} created on GitHub` };
  });
}

export async function mergeCheckAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const e = await work.mergeEligibility(await ctx(), str(fd, "id"));
    return { ok: true, data: { ...e } };
  });
}

export async function mergeAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const method = z.enum(["merge", "squash", "rebase"]).parse(str(fd, "method"));
    await work.mergePullRequest(await ctx(), str(fd, "id"), { method, confirmedHeadSha: str(fd, "sha"), acknowledgeWarnings: bool(fd, "ack") });
    revalidatePath("/pull-requests/" + str(fd, "id"));
    return { ok: true, message: "Pull request merged" };
  });
}

// ---------- planning ----------

export async function createCardAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const due = str(fd, "due");
    await createCard(db, viewer, {
      projectId: str(fd, "projectId"),
      title: str(fd, "title") || undefined,
      workItemId: str(fd, "workItemId") || undefined,
      columnKey: str(fd, "column") || undefined,
      priority: Number(str(fd, "priority") || 0),
      dueDate: due ? new Date(due + "T00:00:00Z") : null,
      milestoneId: str(fd, "milestoneId") || null,
    });
    revalidatePath("/planning");
    return { ok: true, message: "Card added" };
  });
}

/** Called from the board (drag or keyboard). Conflicts are reported so the client can roll back and reload. */
export async function moveCardAction(input: { itemId: string; toColumnKey: string; beforePosition: number | null; afterPosition: number | null; expectedVersion: number }): Promise<ActionResult & { version?: number }> {
  const r = await run(async () => {
    const { viewer } = await requireViewer();
    const res = await moveCard(db, viewer, input);
    return { ok: true, data: { version: res.version } };
  });
  if (r.ok) revalidatePath("/planning");
  return r.ok ? { ...r, version: (r.data as { version: number }).version } : r;
}

export async function addDependencyAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await addDependency(db, viewer, str(fd, "blockerId"), str(fd, "blockedId"));
    revalidatePath("/planning");
    return { ok: true, message: "Dependency added" };
  });
}

export async function createMilestoneAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const name = str(fd, "name");
    if (!name) throw new ValidationError("Name the milestone");
    const start = str(fd, "start");
    const target = str(fd, "target");
    const project = str(fd, "projectId");
    await db.dashboardMilestone.create({ data: { workspaceId: viewer.workspaceId, projectId: project || null, name, description: str(fd, "description") || null, ownerId: viewer.memberId, startDate: start ? new Date(start + "T00:00:00Z") : null, targetDate: target ? new Date(target + "T00:00:00Z") : null } });
    await audit(db, viewer, "milestone.create");
    revalidatePath("/planning");
    return { ok: true, message: "Milestone created" };
  });
}

export async function manualWaitingAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await requestManualReview(db, viewer, {
      workItemId: str(fd, "workItemId") || undefined,
      planningItemId: str(fd, "planningItemId") || undefined,
      reviewerKind: z.enum(["USER", "EXTERNAL_ROLE"]).parse(str(fd, "kind")),
      reviewerRef: str(fd, "ref"),
      reason: str(fd, "reason"),
    });
    revalidatePath("/attention");
    return { ok: true, message: "Marked as waiting. This is a dashboard record; nothing was posted to GitHub." };
  });
}

export async function resolveWaitingAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await resolveManualReview(db, viewer, str(fd, "id"), z.enum(["SATISFIED", "CANCELLED"]).parse(str(fd, "outcome")), str(fd, "note"));
    revalidatePath("/attention");
    return { ok: true, message: "Decision recorded" };
  });
}

// ---------- projects & rules (admin) ----------

export async function createProjectAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const name = str(fd, "name");
    if (!name) throw new ValidationError("Name the project");
    // Resolved before anything is created, so a share that cannot happen never leaves a half-made project behind.
    const spaceId = str(fd, "share") ? await commonSpaceIdForSharing(db) : null;
    const p = await db.project.create({ data: { workspaceId: viewer.workspaceId, name, slug: slugify(name), description: str(fd, "description") || null, spaceId } });
    await createColumnsForProject(db, p.id);
    if (str(fd, "reviewers")) await setProjectReviewers(db, viewer.workspaceId, p.id, p.name, str(fd, "reviewers"));
    await audit(db, viewer, "project.create", { type: "Project", id: p.id });
    revalidatePath("/admin/projects");
    return { ok: true, message: spaceId ? "Project created and shared with the team" : "Project created" };
  });
}

export async function autoSetupAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const ids = strs(fd, "step");
    if (ids.length === 0) throw new ValidationError("Select at least one change to apply");
    const done = await applyAutoSetup(db, viewer, ids, { clonesFolder: str(fd, "folder") || null });
    await audit(db, viewer, "workspace.autosetup", { type: "Workspace", id: viewer.workspaceId }, { steps: done.map((d) => d.id) });
    for (const p of ["/settings", "/admin/projects", "/admin/rules", "/forks", "/attention", "/"]) revalidatePath(p);
    notifyChange("state");
    return { ok: true, message: `${done.length} change${done.length === 1 ? "" : "s"} applied on this computer. Nothing was sent to GitHub.` };
  });
}

export async function setProjectReviewersAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const p = await db.project.findFirst({ where: { id: str(fd, "projectId"), workspaceId: viewer.workspaceId } });
    if (!p) throw new ValidationError("Unknown project");
    const { reviewers } = await setProjectReviewers(db, viewer.workspaceId, p.id, p.name, str(fd, "reviewers"));
    await audit(db, viewer, "project.reviewers", { type: "Project", id: p.id }, { reviewers });
    revalidatePath("/admin/projects");
    revalidatePath("/admin/rules");
    return { ok: true, message: reviewers.length ? `Every pull request in ${p.name} now needs a review from ${reviewers.join(", ")}.` : "Required reviewers removed." };
  });
}

export async function setProjectReposAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const projectId = str(fd, "projectId");
    const p = await db.project.findFirst({ where: { id: projectId, workspaceId: viewer.workspaceId } });
    if (!p) throw new ValidationError("Unknown project");
    const ids = strs(fd, "repo");
    const repos = await db.repository.findMany({ where: { id: { in: ids }, workspaceId: viewer.workspaceId } });
    if (repos.length !== ids.length) throw new ValidationError("Unknown repository");
    await assertSameAudience(db, p.spaceId, ids);
    await db.$transaction([db.projectRepository.deleteMany({ where: { projectId } }), db.projectRepository.createMany({ data: ids.map((repositoryId) => ({ projectId, repositoryId })) })]);
    await audit(db, viewer, "project.repos", { type: "Project", id: projectId }, { repositoryIds: ids });
    revalidatePath("/admin/projects");
    return { ok: true, message: "Project repositories saved. Members are NOT granted access automatically." };
  });
}

export async function setProjectMembersAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const projectId = str(fd, "projectId");
    const p = await db.project.findFirst({ where: { id: projectId, workspaceId: viewer.workspaceId } });
    if (!p) throw new ValidationError("Unknown project");
    const ids = strs(fd, "member");
    const members = await db.member.findMany({ where: { id: { in: ids }, workspaceId: viewer.workspaceId, status: "ACTIVE" } });
    if (members.length !== ids.length) throw new ValidationError("Unknown member");
    await db.$transaction([db.projectMember.deleteMany({ where: { projectId } }), db.projectMember.createMany({ data: ids.map((memberId) => ({ projectId, memberId })) })]);
    await audit(db, viewer, "project.members", { type: "Project", id: projectId }, { memberIds: ids });
    revalidatePath("/admin/projects");
    return { ok: true, message: "Project members saved" };
  });
}

export async function saveRuleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const scope = z.enum(["REPOSITORY", "OWNER", "PROJECT", "WORKSPACE"]).parse(str(fd, "scope"));
    const reviewers = csv(str(fd, "reviewers")).map((ref) => ({ kind: (str(fd, "kind") === "EXTERNAL_ROLE" ? "EXTERNAL_ROLE" : ref.includes("/") ? "TEAM" : "USER") as "USER" | "TEAM" | "EXTERNAL_ROLE", ref: ref.replace(/^@/, "") }));
    if (reviewers.length === 0) throw new ValidationError("Name at least one reviewer");
    const reason = str(fd, "reason");
    if (!reason) throw new ValidationError("Explain the rule so people understand why work is waiting");
    const repositoryId = scope === "REPOSITORY" ? str(fd, "repositoryId") : null;
    const projectId = scope === "PROJECT" ? str(fd, "projectId") : null;
    const ownerLogin = scope === "OWNER" ? str(fd, "ownerLogin") : null;
    if (scope === "REPOSITORY" && !(await db.repository.findFirst({ where: { id: repositoryId!, workspaceId: viewer.workspaceId } }))) throw new ValidationError("Choose a repository");
    if (scope === "PROJECT" && !(await db.project.findFirst({ where: { id: projectId!, workspaceId: viewer.workspaceId } }))) throw new ValidationError("Choose a project");
    if (scope === "OWNER" && !ownerLogin) throw new ValidationError("Enter the GitHub owner");
    const rule = await db.reviewRule.create({ data: { workspaceId: viewer.workspaceId, scope, repositoryId, projectId, ownerLogin, labels: csv(str(fd, "labels")), reviewers, semantics: str(fd, "semantics") === "ALL" ? "ALL" : "ANY", reason } });
    await audit(db, viewer, "rule.create", { type: "ReviewRule", id: rule.id });
    revalidatePath("/admin/rules");
    return { ok: true, message: "Rule saved" };
  });
}

function parseWaitingOn(fd: FormData) {
  const kind = str(fd, "kind");
  return csv(str(fd, "waitingOn")).map((ref) => ({ kind: (kind === "EXTERNAL_ROLE" ? "EXTERNAL_ROLE" : ref.includes("/") ? "TEAM" : "USER") as "USER" | "TEAM" | "EXTERNAL_ROLE", ref: ref.replace(/^@/, "") }));
}

/** A waiting rule: everything that matches waits on the named people until it is merged or closed. Pure configuration, no built-in names. */
export async function saveWaitingRuleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const scope = z.enum(["REPOSITORY", "OWNER", "PROJECT", "WORKSPACE"]).parse(str(fd, "scope"));
    const waitingOn = parseWaitingOn(fd);
    if (waitingOn.length === 0) throw new ValidationError("Name who the work waits on");
    const reason = str(fd, "reason");
    if (!reason) throw new ValidationError("Say why, so people understand why work is waiting");
    const repositoryId = scope === "REPOSITORY" ? str(fd, "repositoryId") : null;
    const projectId = scope === "PROJECT" ? str(fd, "projectId") : null;
    const ownerLogin = scope === "OWNER" ? str(fd, "ownerLogin").replace(/^@/, "") : null;
    if (scope === "REPOSITORY" && !(await db.repository.findFirst({ where: { id: repositoryId!, workspaceId: viewer.workspaceId } }))) throw new ValidationError("Choose a repository");
    if (scope === "PROJECT" && !(await db.project.findFirst({ where: { id: projectId!, workspaceId: viewer.workspaceId } }))) throw new ValidationError("Choose a project");
    if (scope === "OWNER" && !ownerLogin) throw new ValidationError("Enter the GitHub owner");
    const t = str(fd, "itemType");
    const rule = await db.waitingRule.create({ data: { workspaceId: viewer.workspaceId, scope, repositoryId, projectId, ownerLogin, itemType: t === "ISSUE" || t === "ANY" ? t : "PULL_REQUEST", labels: csv(str(fd, "labels")), authors: csv(str(fd, "authors")).map((a) => a.replace(/^@/, "")), includeDrafts: str(fd, "includeDrafts") === "on", waitingOn, reason } });
    await audit(db, viewer, "waitingRule.create", { type: "WaitingRule", id: rule.id });
    revalidatePath("/admin/rules");
    revalidatePath("/attention");
    revalidatePath("/");
    return { ok: true, message: "Waiting rule saved" };
  });
}

export async function toggleWaitingRuleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const r = await db.waitingRule.findFirst({ where: { id: str(fd, "id"), workspaceId: viewer.workspaceId } });
    if (!r) throw new ValidationError("Unknown rule");
    await db.waitingRule.update({ where: { id: r.id }, data: { enabled: !r.enabled } });
    revalidatePath("/admin/rules");
    revalidatePath("/attention");
    revalidatePath("/");
    return { ok: true, message: r.enabled ? "Rule turned off" : "Rule turned on" };
  });
}

export async function deleteWaitingRuleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const r = await db.waitingRule.findFirst({ where: { id: str(fd, "id"), workspaceId: viewer.workspaceId } });
    if (!r) throw new ValidationError("Unknown rule");
    await db.waitingRule.delete({ where: { id: r.id } });
    await audit(db, viewer, "waitingRule.delete", { type: "WaitingRule", id: r.id });
    revalidatePath("/admin/rules");
    revalidatePath("/attention");
    revalidatePath("/");
    return { ok: true, message: "Waiting rule deleted" };
  });
}

export async function deleteRuleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const r = await db.reviewRule.deleteMany({ where: { id: str(fd, "id"), workspaceId: viewer.workspaceId } });
    if (r.count !== 1) throw new ValidationError("Rule not found");
    await audit(db, viewer, "rule.delete", { type: "ReviewRule", id: str(fd, "id") });
    revalidatePath("/admin/rules");
    return { ok: true, message: "Rule deleted" };
  });
}

// ---------- forks ----------

export async function mapForkAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const fork = await requireRepo(db, viewer, str(fd, "forkRepoId"));
    const up = await requireRepo(db, viewer, str(fd, "upstreamRepoId"));
    if (fork.id === up.id) throw new ValidationError("A repository cannot be its own upstream");
    const m = await db.forkMapping.upsert({
      where: { forkRepoId_upstreamRepoId_forkBranch_upstreamBranch: { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: str(fd, "forkBranch") || fork.defaultBranch || "main", upstreamBranch: str(fd, "upstreamBranch") || up.defaultBranch || "main" } },
      create: { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: str(fd, "forkBranch") || fork.defaultBranch || "main", upstreamBranch: str(fd, "upstreamBranch") || up.defaultBranch || "main" },
      update: {},
    });
    await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
    revalidatePath("/forks");
    return { ok: true, message: "Branch mapping saved. A comparison is queued." };
  });
}

export async function refreshForkAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const m = await db.forkMapping.findFirst({ where: { id: str(fd, "mappingId") } });
    if (!m) throw new NotFoundError();
    await requireRepo(db, viewer, m.forkRepoId);
    await requireRepo(db, viewer, m.upstreamRepoId);
    await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
    return { ok: true, message: "Comparison queued" };
  });
}

export async function triageAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const row = await db.upstreamIssueTriage.findFirst({ where: { id: str(fd, "id") }, include: { mapping: true } });
    if (!row) throw new NotFoundError();
    await requireRepo(db, viewer, row.mapping.forkRepoId, "manageWork");
    await requireRepo(db, viewer, row.mapping.upstreamRepoId, "view");
    const status = z.enum(["UNTRIAGED", "WATCHING", "RELEVANT", "ADDRESSED", "IGNORED"]).parse(str(fd, "status"));
    await db.upstreamIssueTriage.update({ where: { id: row.id }, data: { status, note: str(fd, "note") || null, decidedById: viewer.userId } });
    await audit(db, viewer, "triage.set", { type: "UpstreamIssueTriage", id: row.id }, { status });
    revalidatePath("/forks");
    return { ok: true, message: "Triage saved" };
  });
}

export async function ackEvidenceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const row = await db.upstreamPrState.findFirst({ where: { id: str(fd, "id") }, include: { mapping: true } });
    if (!row) throw new NotFoundError();
    await requireRepo(db, viewer, row.mapping.forkRepoId, "manageWork");
    await requireRepo(db, viewer, row.mapping.upstreamRepoId, "view");
    await db.upstreamPrState.update({ where: { id: row.id }, data: { ackedById: viewer.memberId, evidence: "MANUAL_ACK", evidenceNote: "Acknowledged manually by a person. This is a decision, not Git evidence." } });
    await audit(db, viewer, "upstream.ack", { type: "UpstreamPrState", id: row.id });
    revalidatePath("/forks");
    return { ok: true, message: "Acknowledged" };
  });
}

export async function syncForkBranchAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const r = await work.syncForkBranch({ db, v: viewer }, str(fd, "mappingId"), { forkTip: str(fd, "forkTip"), upstreamTip: str(fd, "upstreamTip") });
    revalidatePath("/forks");
    return { ok: r.result !== "conflict", ...(r.result === "conflict" ? { error: r.message } : { message: `${r.message || "Fork updated"} Only the fork on GitHub changed; no local worktree was touched.` }) } as ActionResult;
  });
}

// ---------- local worktrees ----------

export async function mapRootAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await mapLocalRoot(db, viewer, str(fd, "repositoryId"), str(fd, "path"));
    await scanWorktrees(db, viewer, str(fd, "repositoryId"));
    revalidatePath("/branches");
    return { ok: true, message: "Folder mapped and scanned. Only branch names and counts of changed files are read; nothing leaves this computer." };
  });
}

export async function scanRootAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const snap = await scanWorktrees(db, viewer, str(fd, "repositoryId"));
    revalidatePath("/branches");
    return { ok: true, message: `Scanned ${snap.worktrees.length} worktree(s)` };
  });
}

export async function unmapRootAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await unmapLocalRoot(db, viewer, str(fd, "repositoryId"));
    revalidatePath("/branches");
    return { ok: true, message: "Folder forgotten" };
  });
}

// ---------- settings ----------

export async function setTimezoneAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { user } = await requireViewer();
    const tz = str(fd, "timezone");
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch {
      throw new ValidationError("Unknown timezone");
    }
    await db.user.update({ where: { id: user.id }, data: { timezone: tz } });
    revalidatePath("/", "layout");
    return { ok: true, message: "Timezone saved" };
  });
}

export async function saveFilterAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { user } = await requireViewer();
    const name = str(fd, "name");
    if (!name) throw new ValidationError("Name the filter");
    await db.savedFilter.create({ data: { userId: user.id, scope: str(fd, "scope"), name, query: str(fd, "query") } });
    revalidatePath("/pull-requests");
    revalidatePath("/issues");
    return { ok: true, message: "Filter saved" };
  });
}

export async function deleteFilterAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { user } = await requireViewer();
    await db.savedFilter.deleteMany({ where: { id: str(fd, "id"), userId: user.id } });
    revalidatePath("/pull-requests");
    revalidatePath("/issues");
    return { ok: true };
  });
}

export async function markNotificationsReadAction(): Promise<ActionResult> {
  return run(async () => {
    const { user } = await requireViewer();
    await db.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    revalidatePath("/activity");
    return { ok: true };
  });
}

export { requireAdmin, upsertRepository };
export type { RepoMeta };
