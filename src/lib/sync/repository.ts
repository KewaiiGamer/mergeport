import { discussionDownloaded } from "@/lib/sync/discussion-window";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { shouldApplyUpdate } from "@/lib/domain/sync";
import { classifyCompare, classifyUpstreamMerge } from "@/lib/domain/forks";
import { GithubError, type GithubPort, type RemoteComment, type RemoteWorkItem } from "@/lib/github/port";
import { mapLimit } from "@/lib/util";
import { indexList, sameLogin } from "@/lib/domain/text-index";
import { refreshHubWatch } from "@/lib/hub/watch";

/**
 * Repository synchronization. Runs in the worker, with the installation's/connection's broad credential.
 * Nothing here is served to browsers directly: all reads go back through viewer-scoped queries.
 */

/** A database or an open transaction: the webhook path applies one event atomically. */
export type Tx = Db | Prisma.TransactionClient;

export type SyncResult = { items: number; applied: number; skippedStale: number; pages: number; discussionSkipped?: number };

const SKEW_MS = 2 * 60_000;

/**
 * Every status write is guarded: a repository an administrator untracked while a job was queued or running must
 * stay REMOVED. Without this guard a late sync could flip it back to ACTIVE or DISCONNECTED and make it (and its
 * old grants) visible again.
 */
export async function setStatus(db: Db, repositoryId: string, data: Prisma.RepositoryUpdateManyMutationInput) {
  const r = await db.repository.updateMany({ where: { id: repositoryId, trackingStatus: { not: "REMOVED" } }, data });
  if (data.trackingStatus !== undefined) refreshHubWatch(); // ACTIVE <-> DISCONNECTED changes what the hub should relay
  return r;
}

function itemData(i: RemoteWorkItem): Prisma.WorkItemUncheckedUpdateInput {
  return {
    title: i.title,
    body: i.body,
    state: i.state,
    draft: i.draft,
    authorLogin: i.authorLogin,
    authorGithubId: i.authorGithubId,
    authorAvatar: i.authorAvatar,
    labels: i.labels as unknown as Prisma.InputJsonValue,
    assignees: i.assignees as unknown as Prisma.InputJsonValue,
    labelNames: indexList(i.labels.map((l) => l.name)),
    assigneeLogins: indexList(i.assignees),
    milestoneNumber: i.milestoneNumber,
    milestoneTitle: i.milestoneTitle,
    htmlUrl: i.htmlUrl,
    createdAtGh: i.createdAt,
    updatedAtGh: i.updatedAt,
    closedAtGh: i.closedAt,
    mergedAtGh: i.mergedAt,
    syncedAt: new Date(),
  };
}

/**
 * Upsert one item, idempotently and never backwards in time. Returns whether anything was written.
 * `opts.partial` (webhook payloads) keeps the stored mergeable state, checks state and size counters when the incoming
 * pull request has no value for them, instead of resetting them the way a full sync (which always has them) would.
 */
export async function applyWorkItem(db: Tx, repositoryId: string, i: RemoteWorkItem, pr?: Partial<RemoteWorkItem> & { checks?: "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN" }, opts: { partial?: boolean } = {}): Promise<boolean> {
  const existing = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number: i.number } }, select: { id: true, updatedAtGh: true } });
  if (!shouldApplyUpdate(existing, i.updatedAt)) return false;
  let prFields: Prisma.WorkItemUncheckedUpdateInput = pr
    ? { headSha: pr.headSha ?? null, headRef: pr.headRef ?? null, baseRef: pr.baseRef ?? null, mergeable: pr.mergeable ?? "UNKNOWN", additions: pr.additions ?? null, deletions: pr.deletions ?? null, changedFiles: pr.changedFiles ?? null, checksState: pr.checks ?? "NONE" }
    : {};
  if (pr && opts.partial) {
    prFields = { headSha: pr.headSha ?? null, headRef: pr.headRef ?? null, baseRef: pr.baseRef ?? null };
    if (pr.mergeable !== undefined) prFields.mergeable = pr.mergeable;
    if (pr.additions != null) prFields.additions = pr.additions;
    if (pr.deletions != null) prFields.deletions = pr.deletions;
    if (pr.changedFiles != null) prFields.changedFiles = pr.changedFiles;
    if (pr.checks !== undefined) prFields.checksState = pr.checks;
  }
  const create = { ...(itemData(i) as object), ...(prFields as object), repositoryId, githubId: i.githubId, number: i.number, type: i.type } as Prisma.WorkItemUncheckedCreateInput;
  if (opts.partial) {
    // Webhook path: the age check and the write are ONE statement, so a newer row is never overwritten even when two writers
    // interleave between the read above and this write.
    const r = await db.workItem.updateMany({ where: { repositoryId, number: i.number, updatedAtGh: { lte: i.updatedAt } }, data: { ...itemData(i), ...prFields } });
    if (r.count === 1) return true;
    if (existing) return false; // the row exists and is newer
    try {
      await db.workItem.create({ data: create });
      return true;
    } catch {
      // created by another writer in between: only an equal or older row may still be updated
      return (await db.workItem.updateMany({ where: { repositoryId, number: i.number, updatedAtGh: { lte: i.updatedAt } }, data: { ...itemData(i), ...prFields } })).count === 1;
    }
  }
  await db.workItem.upsert({
    where: { repositoryId_number: { repositoryId, number: i.number } },
    create,
    update: { ...itemData(i), ...prFields },
  });
  return true;
}

/** Upsert one issue comment or inline review comment by its GitHub id: the write the full sync and the webhook path share. */
export function upsertComment(db: Tx, workItemId: string, kind: "ISSUE_COMMENT" | "REVIEW_COMMENT", c: RemoteComment) {
  return db.workItemComment.upsert({
    where: { workItemId_kind_githubId: { workItemId, kind, githubId: c.githubId } },
    create:
      kind === "ISSUE_COMMENT"
        ? { workItemId, githubId: c.githubId, kind, authorLogin: c.login, body: c.body, createdAtGh: c.createdAt, updatedAtGh: c.updatedAt }
        : { workItemId, githubId: c.githubId, kind, authorLogin: c.login, body: c.body, path: c.path, line: c.line, commitSha: c.commitSha, threadKey: c.threadKey, createdAtGh: c.createdAt, updatedAtGh: c.updatedAt },
    update: { body: c.body, updatedAtGh: c.updatedAt },
  });
}

async function syncDiscussion(db: Db, port: GithubPort, owner: string, repo: string, repositoryId: string, i: RemoteWorkItem, now: Date) {
  const wi = await db.workItem.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId, number: i.number } } });
  const [issueComments, reviewComments] = await Promise.all([port.listIssueComments(owner, repo, i.number), i.type === "PULL_REQUEST" ? port.listReviewComments(owner, repo, i.number) : Promise.resolve([])]);
  for (const c of issueComments) await upsertComment(db, wi.id, "ISSUE_COMMENT", c);
  for (const c of reviewComments) await upsertComment(db, wi.id, "REVIEW_COMMENT", c);
  if (i.type !== "PULL_REQUEST") return;
  const [reviews, requested] = await Promise.all([port.listReviews(owner, repo, i.number), port.listRequestedReviewers(owner, repo, i.number)]);
  for (const r of reviews) {
    await db.workItemComment.upsert({
      where: { workItemId_kind_githubId: { workItemId: wi.id, kind: "REVIEW", githubId: r.githubId } },
      create: { workItemId: wi.id, githubId: r.githubId, kind: "REVIEW", authorLogin: r.login, body: r.body, reviewState: r.state, commitSha: r.commitSha, createdAtGh: r.submittedAt, updatedAtGh: r.submittedAt },
      update: { reviewState: r.state, body: r.body },
    });
  }
  // Reconcile review requests: new ones get a first-observed time, vanished ones are closed (cancelled or fulfilled).
  // A review request only means something while the pull request is open. GitHub keeps listing the reviewers of a merged or
  // closed PR, so history must not turn into "waiting on" rows or fresh notifications.
  const isOpen = i.state === "OPEN";
  const active = isOpen ? [...requested.users.map((u) => ({ kind: "USER" as const, ref: u })), ...requested.teams.map((t) => ({ kind: "TEAM" as const, ref: t }))] : [];
  if (!isOpen) await db.notification.deleteMany({ where: { kind: "review-requested", readAt: null, href: `/pull-requests/${wi.id}` } });
  const open = await db.reviewRequest.findMany({ where: { workItemId: wi.id, removedAt: null } });
  for (const o of open) {
    if (!active.some((a) => a.kind === o.kind && a.ref.toLowerCase() === o.reviewerRef.toLowerCase())) await db.reviewRequest.update({ where: { id: o.id }, data: { removedAt: now } });
  }
  for (const a of active) {
    if (!open.some((o) => o.kind === a.kind && o.reviewerRef.toLowerCase() === a.ref.toLowerCase())) {
      await db.reviewRequest.create({ data: { workItemId: wi.id, kind: a.kind, reviewerRef: a.ref, requestedAt: now } });
      if (a.kind === "USER") await notifyReviewer(db, wi.id, a.ref, i.title);
    }
  }
}

/** Notifications are dashboard records only. They carry repositoryId so reads can be filtered by current grants. */
async function notifyReviewer(db: Db, workItemId: string, login: string, title: string) {
  const wi = await db.workItem.findUniqueOrThrow({ where: { id: workItemId }, include: { repository: true } });
  const candidates = await db.member.findMany({ where: { workspaceId: wi.repository.workspaceId, status: "ACTIVE", user: { login: { contains: login } } }, include: { user: true } });
  const member = candidates.find((m) => sameLogin(m.user.login, login));
  if (!member) return;
  await db.notification.create({ data: { workspaceId: wi.repository.workspaceId, userId: member.userId, repositoryId: wi.repositoryId, kind: "review-requested", title: `Review requested: ${title}`, href: `/pull-requests/${wi.id}` } });
}

export async function syncRepository(db: Db, port: GithubPort, repositoryId: string, opts: { full?: boolean; now?: Date } = {}): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  const repo = await db.repository.findUnique({ where: { id: repositoryId }, include: { owner: true } });
  if (!repo || repo.trackingStatus === "REMOVED") return { items: 0, applied: 0, skippedStale: 0, pages: 0 };
  const owner = repo.owner.login;
  const name = repo.name;
  const since = !opts.full && repo.lastSyncedAt ? new Date(repo.lastSyncedAt.getTime() - SKEW_MS) : undefined;
  const result: SyncResult = { items: 0, applied: 0, skippedStale: 0, pages: 0 };

  try {
    // Refresh canonical metadata first: handles rename, transfer, default-branch change and archive.
    const meta = await port.getRepository(owner, name);
    await db.repository.updateMany({
      where: { id: repo.id, trackingStatus: { not: "REMOVED" } },
      data: { fullName: meta.fullName, name: meta.name, defaultBranch: meta.defaultBranch, archived: meta.archived, visibility: meta.visibility, isFork: meta.isFork, parentGithubId: meta.parentGithubId ?? null, parentFullName: meta.parentFullName ?? null, permissions: (meta.permissions ?? undefined) as Prisma.InputJsonValue | undefined },
    });

    const touched: RemoteWorkItem[] = [];
    for (let page = 1; ; ) {
      const p = await port.listIssuesAndPulls(owner, name, { since, page });
      result.pages++;
      for (const i of p.items) {
        result.items++;
        touched.push(i);
      }
      if (!p.nextPage) break;
      page = p.nextPage;
    }

    await mapLimit(touched, 3, async (i) => {
      let prDetail: Awaited<ReturnType<GithubPort["getPull"]>> | undefined;
      let checks: "NONE" | "PENDING" | "SUCCESS" | "FAILURE" | "UNKNOWN" | undefined;
      if (i.type === "PULL_REQUEST" && i.state === "OPEN") {
        prDetail = await port.getPull(owner, name, i.number);
        checks = prDetail.headSha ? await port.getChecksState(owner, name, prDetail.headSha) : "NONE";
      }
      const before = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: repo.id, number: i.number } }, select: { updatedAtGh: true } });
      const unchanged = !!before && before.updatedAtGh.getTime() === i.updatedAt.getTime();
      const applied = await applyWorkItem(db, repo.id, prDetail ?? i, prDetail ? { ...prDetail, checks } : undefined);
      if (applied) {
        result.applied++;
        // Closed or merged items that have not changed since the last run keep the conversation already stored (a repeated refresh
        // must not download it again); open items are always re-read, since reviews and requests change what is pending.
        if (unchanged && i.state !== "OPEN") result.discussionSkipped = (result.discussionSkipped ?? 0) + 1;
        else if (discussionDownloaded(i.state, i.updatedAt, now)) await syncDiscussion(db, port, owner, name, repo.id, i, now);
        else result.discussionSkipped = (result.discussionSkipped ?? 0) + 1;
      } else result.skippedStale++;
    });

    const branches = await port.listBranches(owner, name);
    await db.$transaction([
      db.branch.deleteMany({ where: { repositoryId: repo.id, name: { notIn: branches.map((b) => b.name) } } }),
      ...branches.map((b) =>
        db.branch.upsert({ where: { repositoryId_name: { repositoryId: repo.id, name: b.name } }, create: { repositoryId: repo.id, name: b.name, sha: b.sha, isDefault: b.isDefault }, update: { sha: b.sha, isDefault: b.isDefault, fetchedAt: now } }),
      ),
    ]);

    // Review requests left on pull requests that are no longer open (older syncs recorded them) stop counting as pending.
    await db.reviewRequest.updateMany({ where: { removedAt: null, workItem: { repositoryId: repo.id, state: { not: "OPEN" } } }, data: { removedAt: now } });
    const staleNotes = await db.notification.findMany({ where: { kind: "review-requested", readAt: null, repositoryId: repo.id }, select: { id: true, href: true } });
    if (staleNotes.length) {
      const ids = staleNotes.map((n) => n.href?.replace("/pull-requests/", "") ?? "");
      const open = new Set((await db.workItem.findMany({ where: { id: { in: ids }, state: "OPEN" }, select: { id: true } })).map((w) => w.id));
      await db.notification.deleteMany({ where: { id: { in: staleNotes.filter((n, k) => !open.has(ids[k])).map((n) => n.id) } } });
    }
    await setStatus(db, repo.id, { lastSyncedAt: now, syncError: null, rateLimited: false, trackingStatus: "ACTIVE", statusDetail: null });
    return result;
  } catch (e) {
    if (e instanceof GithubError) {
      // Distinguish: rate limit (stale but healthy), permission loss (disconnected), unknown (error). Never "zero open work".
      if (e.kind === "rate-limited") await setStatus(db, repo.id, { rateLimited: true, syncError: e.message });
      else if (e.kind === "not-found" || e.kind === "forbidden" || e.kind === "auth" || e.kind === "sso") await setStatus(db, repo.id, { trackingStatus: "DISCONNECTED", statusDetail: e.message, syncError: e.message });
      else await setStatus(db, repo.id, { syncError: e.message });
    }
    throw e;
  }
}

/** Refetch ONE item (used for webhook deliveries). The payload is never trusted; the API is the source. */
export async function syncItem(db: Db, port: GithubPort, repositoryId: string, number: number, now = new Date()) {
  const repo = await db.repository.findUnique({ where: { id: repositoryId }, include: { owner: true } });
  if (!repo || repo.trackingStatus === "REMOVED") return false;
  const pr = await port.getPull(repo.owner.login, repo.name, number).catch((e) => {
    if (e instanceof GithubError && e.kind === "not-found") return null; // may be an issue
    throw e;
  });
  const base = pr ?? (await port.listIssuesAndPulls(repo.owner.login, repo.name, { page: 1 })).items.find((i) => i.number === number);
  if (!base) return false;
  const checks = pr?.headSha ? await port.getChecksState(repo.owner.login, repo.name, pr.headSha) : undefined;
  const applied = await applyWorkItem(db, repo.id, base, pr ? { ...pr, checks } : undefined);
  if (applied) await syncDiscussion(db, port, repo.owner.login, repo.name, repo.id, base, now);
  return applied;
}

// ---------- forks ----------

export async function syncFork(db: Db, port: GithubPort, mappingId: string, now = new Date()) {
  const m = await db.forkMapping.findUnique({ where: { id: mappingId }, include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } } } });
  if (!m) return;
  const up = { owner: m.upstream.owner.login, repo: m.upstream.name, branch: m.upstreamBranch };
  const fk = { owner: m.fork.owner.login, branch: m.forkBranch };

  const outcome = await port.compare(up, fk);
  const view = classifyCompare(outcome);
  const [upBranches, forkBranches] = await Promise.all([port.listBranches(up.owner, up.repo).catch(() => []), port.listBranches(m.fork.owner.login, m.fork.name).catch(() => [])]);
  const upTip = upBranches.find((b) => b.name === m.upstreamBranch)?.sha ?? null;
  const forkTip = forkBranches.find((b) => b.name === m.forkBranch)?.sha ?? null;
  await db.forkComparison.create({
    data: {
      mappingId: m.id,
      status: view.status,
      aheadBy: view.forkAhead,
      behindBy: view.missingUpstream,
      baseSha: upTip, // upstream tip at compare time
      headSha: forkTip, // fork tip at compare time
      truncated: view.truncated,
      error: view.status === "unavailable" || view.status === "unknown" ? view.explanation : null,
      comparedAt: now,
    },
  });

  // Upstream merged PRs: ancestry evidence only. Titles and numbers are never evidence.
  const merged = await db.workItem.findMany({ where: { repositoryId: m.upstreamRepoId, type: "PULL_REQUEST", state: "MERGED" } });
  for (const pr of merged) {
    const sha = await port.getPullMergeSha(up.owner, up.repo, pr.number).catch(() => null);
    const existing = await db.upstreamPrState.findUnique({ where: { mappingId_number: { mappingId: m.id, number: pr.number } } });
    const ancestry = sha ? await port.isAncestor({ owner: up.owner, repo: up.repo }, sha, `${fk.owner}:${fk.branch}`) : "unknown";
    const c = classifyUpstreamMerge({ ancestry, patchEquivalentCommitsFound: false, titleOrNumberMatch: false, manualAck: !!existing?.ackedById, mergeShaKnown: !!sha });
    await db.upstreamPrState.upsert({
      where: { mappingId_number: { mappingId: m.id, number: pr.number } },
      create: { mappingId: m.id, number: pr.number, title: pr.title, state: "merged", htmlUrl: pr.htmlUrl, mergeSha: sha, mergedAtGh: pr.mergedAtGh, evidence: c.evidence, evidenceNote: c.note },
      update: { title: pr.title, mergeSha: sha, mergedAtGh: pr.mergedAtGh, evidence: c.evidence, evidenceNote: c.note },
    });
  }
  // Upstream open issues enter triage once; later decisions are never overwritten by sync.
  const issues = await db.workItem.findMany({ where: { repositoryId: m.upstreamRepoId, type: "ISSUE", state: "OPEN" } });
  for (const i of issues) {
    await db.upstreamIssueTriage.upsert({ where: { mappingId_issueNumber: { mappingId: m.id, issueNumber: i.number } }, create: { mappingId: m.id, issueNumber: i.number, title: i.title, htmlUrl: i.htmlUrl }, update: { title: i.title } });
  }
}
