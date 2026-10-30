import type { Db } from "@/lib/db";
import { OctokitPort } from "@/lib/github/octokit";
import type { RemoteComment, RemoteWorkItem } from "@/lib/github/port";
import { applyWorkItem, upsertComment, type Tx } from "@/lib/sync/repository";

/**
 * Applies a GitHub webhook delivery relayed by the hub. Issues, pull request fields and issue / inline review comments are
 * written straight to the local database through the same functions the full sync uses (so "never write an older updatedAt"
 * holds); every other event, and any payload that does not have the fields the mapping needs, asks for a refresh of that
 * repository instead. Nothing here throws: a malformed event must never block later ones.
 */

export type GithubEvent = { repoId: string; event: string; delivery: string; payload: unknown | null };
export type GithubEventDeps = {
  /** Asks for a (coalesced, rate-limited) refresh of one local repository. `bulk` events (checks, statuses, branches) are refreshed less often. */
  refresh?(repositoryId: string, kind: "item" | "bulk"): void;
  /** Called after a direct apply wrote something. */
  notify?(): void;
};

const SEEN_MAX = 200;
const seen = new Set<string>();
/** Forgets the delivery ids seen so far (tests). */
export const resetGithubEventState = () => {
  seen.clear();
  queues.clear();
  deleted.clear();
};

/** Events of one repository are handled one after the other, in arrival order; a failure never blocks the next. */
const queues = new Map<string, Promise<void>>();

/** Comments GitHub told us were deleted (per repository, bounded): a late `created` or `edited` for one must not bring it back. */
const deleted = new Map<string, Set<string>>();
const DELETED_MAX = 1000;
const markDeleted = (repoId: string, key: string) => {
  let set = deleted.get(repoId);
  if (!set) deleted.set(repoId, (set = new Set()));
  set.add(key);
  if (set.size > DELETED_MAX) set.delete(set.values().next().value as string);
};

const remember = (delivery: string): boolean => {
  if (seen.has(delivery)) return false;
  seen.add(delivery);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
  return true;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => Number.isSafeInteger(v);
const isDate = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const optStr = (v: unknown) => v === undefined || v === null || isStr(v);
const optDate = (v: unknown) => v === undefined || v === null || isDate(v);

/** The fields toWorkItem reads from an issue or pull request object. */
function validItem(o: unknown): o is Obj {
  if (!isObj(o)) return false;
  if (!isNum(o.id) || !isNum(o.number) || !isStr(o.title) || !isStr(o.html_url)) return false;
  if (o.state !== "open" && o.state !== "closed") return false;
  if (!isDate(o.created_at) || !isDate(o.updated_at) || !optDate(o.closed_at) || !optStr(o.body)) return false;
  if (o.user !== undefined && o.user !== null && (!isObj(o.user) || !optStr(o.user.login) || !optStr(o.user.avatar_url) || (o.user.id !== undefined && !isNum(o.user.id)))) return false;
  if (o.labels !== undefined && (!Array.isArray(o.labels) || !o.labels.every((l) => isStr(l) || (isObj(l) && isStr(l.name) && optStr(l.color))))) return false;
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
async function applyPull(db: Tx, repositoryId: string, pr: Obj): Promise<{ id: string; wrote: boolean }> {
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
async function closeReviewRequests(db: Tx, workItemId: string) {
  await db.reviewRequest.updateMany({ where: { workItemId, removedAt: null }, data: { removedAt: new Date() } });
  await db.notification.deleteMany({ where: { kind: "review-requested", readAt: null, href: `/pull-requests/${workItemId}` } });
}

async function applyComment(db: Tx, repositoryId: string, e: { action: string; payload: Obj }, review: boolean): Promise<boolean> {
  const { action, payload } = e;
  if (action !== "created" && action !== "edited" && action !== "deleted") return fallback();
  const comment = payload.comment;
  if (!validComment(comment, review)) return fallback();
  const holder = review ? payload.pull_request : payload.issue;
  if (!(review ? validPull(holder) : validItem(holder))) return fallback();
  const item = holder as Obj;
  const number = item.number as number;
  const kind = review ? "REVIEW_COMMENT" : "ISSUE_COMMENT";
  const key = `${kind}:${comment.id}`;
  let wi = await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId, number } }, select: { id: true } });
  if (action === "deleted") {
    markDeleted(repositoryId, key);
    if (!wi) return false;
    const r = await db.workItemComment.deleteMany({ where: { workItemId: wi.id, kind, githubId: BigInt(comment.id as number) } });
    return r.count > 0;
  }
  if (deleted.get(repositoryId)?.has(key)) return false; // already deleted by a later event that arrived first
  let wrote = false;
  if (!wi) {
    // An issue-shaped object of a pull request is not a pull request row: only a full pull_request object may create one.
    if (!review && item.pull_request !== undefined) return fallback();
    if (review) wi = { id: (await applyPull(db, repositoryId, item)).id };
    else {
      await applyWorkItem(db, repositoryId, OctokitPort.toWorkItem(item), undefined, { partial: true });
      wi = await db.workItem.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId, number } }, select: { id: true } });
    }
    wrote = true;
  }
  const remote: RemoteComment = review ? OctokitPort.toReviewComment(comment) : OctokitPort.toComment(comment);
  // One statement checks the age and writes: an older edit never overwrites a newer comment.
  const upd = await db.workItemComment.updateMany({ where: { workItemId: wi.id, kind, githubId: remote.githubId, updatedAtGh: { lte: remote.updatedAt } }, data: { body: remote.body, updatedAtGh: remote.updatedAt } });
  if (upd.count === 1) return true;
  const have = await db.workItemComment.findUnique({ where: { workItemId_kind_githubId: { workItemId: wi.id, kind, githubId: remote.githubId } }, select: { id: true } });
  if (have) return wrote; // exists and is newer
  await upsertComment(db, wi.id, kind, remote);
  return true;
}

/** Returns true when something was written. Throws Fallback when the event cannot be applied from its payload. */
async function applyDirect(db: Tx, repositoryId: string, e: GithubEvent): Promise<boolean> {
  const p = e.payload;
  if (!isObj(p) || !isStr(p.action)) return fallback();
  switch (e.event) {
    case "issues": {
      if (!validItem(p.issue) || p.issue.pull_request !== undefined || p.action === "deleted" || p.action === "transferred") return fallback();
      return applyWorkItem(db, repositoryId, OctokitPort.toWorkItem(p.issue), undefined, { partial: true });
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

const BULK = new Set(["check_run", "check_suite", "status", "push", "create", "delete"]);

export function handleGithubEvent(db: Db, e: GithubEvent, deps: GithubEventDeps = {}): Promise<void> {
  const key = isStr(e?.repoId) ? e.repoId : "";
  const run = (queues.get(key) ?? Promise.resolve()).then(() => handleOne(db, e, deps));
  const tail = run.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return run;
}

async function handleOne(db: Db, e: GithubEvent, deps: GithubEventDeps): Promise<void> {
  try {
    if (!isStr(e?.repoId) || !/^\d{1,19}$/.test(e.repoId) || !isStr(e.event) || !isStr(e.delivery)) return;
    const repos = await db.repository.findMany({ where: { githubId: BigInt(e.repoId), trackingStatus: "ACTIVE", isDemo: false }, select: { id: true } });
    if (repos.length === 0) return;
    if (!remember(e.delivery)) return;
    for (const repo of repos) {
      try {
        if (e.payload === null || !DIRECT.has(e.event)) fallback();
        // All writes of one event commit together or not at all; the redraw happens after the commit.
        if (await db.$transaction((tx) => applyDirect(tx, repo.id, e))) deps.notify?.();
      } catch {
        // Fallback: an event that is not applied directly, a payload that does not fit, or a failed write
        try {
          deps.refresh?.(repo.id, BULK.has(e.event) ? "bulk" : "item");
        } catch {
          // a refresher failure never blocks later events
        }
      }
    }
  } catch {
    // never throws out of the message handler
  }
}
