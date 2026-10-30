import type { Db } from "@/lib/db";
import { OctokitPort } from "@/lib/github/octokit";
import type { RemoteComment, RemoteWorkItem } from "@/lib/github/port";
import { applyWorkItem, upsertComment } from "@/lib/sync/repository";

/**
 * Applies a GitHub webhook delivery relayed by the hub. Issues, pull request fields and issue / inline review comments are
 * written straight to the local database through the same functions the full sync uses (so "never write an older updatedAt"
 * holds); every other event, and any payload that does not have the fields the mapping needs, asks for a refresh of that
 * repository instead. Nothing here throws: a malformed event must never block later ones.
 */

export type GithubEvent = { repoId: string; event: string; delivery: string; payload: unknown | null };
export type GithubEventDeps = {
  /** Asks for a (coalesced, rate-limited) refresh of one local repository. */
  refresh?(repositoryId: string): void;
  /** Called after a direct apply wrote something. */
  notify?(): void;
};

const SEEN_MAX = 200;
const seen = new Set<string>();
/** Forgets the delivery ids seen so far (tests). */
export const resetGithubEventState = () => seen.clear();

const remember = (delivery: string): boolean => {
  if (seen.has(delivery)) return false;
  seen.add(delivery);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return true;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown) => v === undefined || v === null || isStr(v);
const optDate = (v: unknown) => v === undefined || v === null || isDate(v);

/** The fields toWorkItem reads from an issue or pull request object. */
function validItem(o: unknown): o is Obj {
  if (!isObj(o)) return false;
  if (!isNum(o.id) || !isNum(o.number) || !isStr(o.title) || !isStr(o.html_url)) return false;
  if (o.state !== "open" && o.state !== "closed") return false;
  if (!isDate(o.created_at) || !isDate(o.updated_at) || !optDate(o.closed_at) || !optStr(o.body)) return false;
  if (o.user !== undefined && o.user !== null && (!isObj(o.user) || !optStr(o.user.login) || (o.user.id !== undefined && !isNum(o.user.id)))) return false;
  if (o.labels !== undefined && (!Array.isArray(o.labels) || !o.labels.every((l) => isStr(l) || (isObj(l) && isStr(l.name))))) return false;
  if (o.assignees !== undefined && (!Array.isArray(o.assignees) || !o.assignees.every((a) => isObj(a) && isStr(a.login)))) return false;
  if (o.milestone !== undefined && o.milestone !== null && (!isObj(o.milestone) || !isNum(o.milestone.number) || !isStr(o.milestone.title))) return false;
  return true;
}

function validPull(o: unknown): o is Obj {
  if (!validItem(o)) return false;
  const p = o as Obj;
  if (!isObj(p.head) || !isStr(p.head.sha) || !isStr(p.head.ref) || !isObj(p.base) || !isStr(p.base.ref)) return false;
  if (!optDate(p.merged_at)) return false;
  if (p.merged !== undefined && typeof p.merged !== "boolean") return false;
  if (p.draft !== undefined && typeof p.draft !== "boolean") return false;
  for (const k of ["additions", "deletions", "changed_files"]) if (p[k] !== undefined && !isNum(p[k])) return false;
  return true;
}

function validComment(o: unknown, review: boolean): o is Obj {
  if (!isObj(o)) return false;
  if (!isNum(o.id) || !isDate(o.created_at) || !isDate(o.updated_at) || !optStr(o.body)) return false;
  if (o.user !== undefined && o.user !== null && (!isObj(o.user) || !optStr(o.user.login))) return false;
  if (review) {
    if (!optStr(o.path) || !optStr(o.commit_id)) return false;
    for (const k of ["line", "original_line", "in_reply_to_id"]) if (o[k] !== undefined && o[k] !== null && !isNum(o[k])) return false;
  }
  return true;
}

const DIRECT = new Set(["issues", "pull_request", "issue_comment", "pull_request_review_comment"]);
const REVIEW_REQUEST_ACTIONS = new Set(["review_requested", "review_request_removed"]);

class Fallback extends Error {}
const fallback = (): never => {
  throw new Fallback();
};

/** Applies the work item of a pull request payload. Returns the local work item id and whether a row was written. */
async function applyPull(db: Db, repositoryId: string, pr: Obj): Promise<{ id: string; wrote: boolean }> {
  const mapped = OctokitPort.toPull({ ...pr, merged: pr.merged ?? !!pr.merged_at });
  const existing = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number: mapped.number } }, select: { headSha: true } });
  const extra: Partial<RemoteWorkItem> & { checks?: "PENDING" } = { ...mapped, mergeable: typeof pr.mergeable === "boolean" ? mapped.mergeable : undefined };
  // Checks run for the new commit; the check events fall back to a refresh that reads the real state.
  if ((existing?.headSha ?? null) !== mapped.headSha) extra.checks = "PENDING";
  const wrote = await applyWorkItem(db, repositoryId, mapped, extra, { partial: true });
  const row = await db.workItem.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId, number: mapped.number } }, select: { id: true } });
  if (wrote && mapped.state !== "OPEN") await closeReviewRequests(db, row.id);
  return { id: row.id, wrote };
}

/** A review request only means something while the pull request is open (the full sync closes them the same way). */
async function closeReviewRequests(db: Db, workItemId: string) {
  await db.reviewRequest.updateMany({ where: { workItemId, removedAt: null }, data: { removedAt: new Date() } });
  await db.notification.deleteMany({ where: { kind: "review-requested", readAt: null, href: `/pull-requests/${workItemId}` } });
}

async function applyComment(db: Db, repositoryId: string, e: { action: string; payload: Obj }, review: boolean): Promise<boolean> {
  const { action, payload } = e;
  if (action !== "created" && action !== "edited" && action !== "deleted") return fallback();
  const comment = payload.comment;
  if (!validComment(comment, review)) return fallback();
  const holder = review ? payload.pull_request : payload.issue;
  if (!(review ? validPull(holder) : validItem(holder))) return fallback();
  const item = holder as Obj;
  const number = item.number as number;
  const kind = review ? "REVIEW_COMMENT" : "ISSUE_COMMENT";
  let wi = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number } }, select: { id: true } });
  if (action === "deleted") {
    if (!wi) return false;
    const r = await db.workItemComment.deleteMany({ where: { workItemId: wi.id, kind, githubId: BigInt(comment.id as number) } });
    return r.count > 0;
  }
  let wrote = false;
  if (!wi) {
    if (review) wi = { id: (await applyPull(db, repositoryId, item)).id };
    else {
      await applyWorkItem(db, repositoryId, OctokitPort.toWorkItem(item));
      wi = await db.workItem.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId, number } }, select: { id: true } });
    }
    wrote = true;
  }
  const remote: RemoteComment = review ? OctokitPort.toReviewComment(comment) : OctokitPort.toComment(comment);
  const have = await db.workItemComment.findUnique({ where: { workItemId_kind_githubId: { workItemId: wi.id, kind, githubId: remote.githubId } }, select: { updatedAtGh: true } });
  if (have && have.updatedAtGh.getTime() > remote.updatedAt.getTime()) return wrote;
  await upsertComment(db, wi.id, kind, remote);
  return true;
}

/** Returns true when something was written. Throws Fallback when the event cannot be applied from its payload. */
async function applyDirect(db: Db, repositoryId: string, e: GithubEvent): Promise<boolean> {
  const p = e.payload;
  if (!isObj(p) || !isStr(p.action)) return fallback();
  switch (e.event) {
    case "issues": {
      if (!validItem(p.issue) || p.issue.pull_request !== undefined) return fallback();
      return applyWorkItem(db, repositoryId, OctokitPort.toWorkItem(p.issue));
    }
    case "pull_request": {
      if (REVIEW_REQUEST_ACTIONS.has(p.action) || !validPull(p.pull_request)) return fallback();
      return (await applyPull(db, repositoryId, p.pull_request)).wrote;
    }
    case "issue_comment":
      return applyComment(db, repositoryId, { action: p.action, payload: p }, false);
    case "pull_request_review_comment":
      return applyComment(db, repositoryId, { action: p.action, payload: p }, true);
  }
  return fallback();
}

export async function handleGithubEvent(db: Db, e: GithubEvent, deps: GithubEventDeps = {}): Promise<void> {
  try {
    if (!isStr(e?.repoId) || !/^\d{1,19}$/.test(e.repoId) || !isStr(e.event) || !isStr(e.delivery)) return;
    const repos = await db.repository.findMany({ where: { githubId: BigInt(e.repoId), trackingStatus: "ACTIVE" }, select: { id: true } });
    if (repos.length === 0) return;
    if (!remember(e.delivery)) return;
    for (const repo of repos) {
      try {
        if (e.payload === null || !DIRECT.has(e.event)) fallback();
        if (await applyDirect(db, repo.id, e)) deps.notify?.();
      } catch {
        // Fallback: an event that is not applied directly, a payload that does not fit, or a failed write
        try {
          deps.refresh?.(repo.id);
        } catch {
          // a refresher failure never blocks later events
        }
      }
    }
  } catch {
    // never throws out of the message handler
  }
}
