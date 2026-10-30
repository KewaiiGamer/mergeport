import path from "node:path";
import fs from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrisma, type Db } from "@/lib/db";
import { truncateAll } from "@/lib/demo/seed";
import { handleGithubEvent, resetGithubEventState, type GithubEvent } from "@/lib/hub/gh-events";
import { OctokitPort, createOctokit } from "@/lib/github/octokit";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { syncRepository } from "@/lib/sync/repository";
import { testDb } from "./helpers";
import { FIXTURE_REPO_ID, restFetch, webhook } from "./github-webhooks";

const db = testDb();
const REPO_ID = String(FIXTURE_REPO_ID);
const META: RepoMeta = {
  githubId: FIXTURE_REPO_ID, fullName: "octo-org/hello-world", name: "hello-world", htmlUrl: "https://github.com/octo-org/hello-world", visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: 583231n, login: "octo-org", type: "ORGANIZATION" },
};

/** What the handler is given to do; records instead of acting. */
function deps() {
  const log = { refreshed: [] as string[], notified: 0 };
  return { log, deps: { refresh: (id: string) => void log.refreshed.push(id), notify: () => void log.notified++ } };
}

let n = 0;
const relay = (name: string, o: Partial<GithubEvent> & { patch?: (p: any) => void } = {}): GithubEvent & { payload: any } => {
  const w = webhook(name);
  o.patch?.(w.payload);
  return { repoId: REPO_ID, event: w.event, delivery: o.delivery ?? `delivery-${++n}`, payload: "payload" in o ? (o.payload as unknown) : w.payload };
};

let repoId: string;
beforeEach(async () => {
  resetGithubEventState();
  await truncateAll(db);
  const ws = await db.workspace.create({ data: { name: "ws" } });
  repoId = (await upsertRepository(db, ws.id, META)).id;
});

const items = () => db.workItem.findMany({ where: { repositoryId: repoId }, orderBy: { number: "asc" } });
const one = (number: number) => db.workItem.findUniqueOrThrow({ where: { repositoryId_number: { repositoryId: repoId, number } } });

// ---- the full sync's result for the equivalent REST data, in a second database ----
const syncFile = path.resolve(".data", `gh-events-sync-${process.pid}.db`);
let syncDb: Db | null = null;
afterAll(async () => {
  await syncDb?.$disconnect();
  for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(syncFile + sfx, { force: true });
});

/** Runs the real full sync (OctokitPort mapping included) against a fake REST API serving `rest`, and returns what it stored. */
async function fullSync(rest: Parameters<typeof restFetch>[0], now: Date) {
  syncDb ??= createPrisma(syncFile);
  await truncateAll(syncDb);
  const ws = await syncDb.workspace.create({ data: { name: "ws" } });
  const repo = await upsertRepository(syncDb, ws.id, META);
  const port = new OctokitPort(createOctokit(undefined, restFetch(rest)));
  await syncRepository(syncDb, port, repo.id, { full: true, now });
  const wi = await syncDb.workItem.findMany({ where: { repositoryId: repo.id }, orderBy: { number: "asc" } });
  const comments = await syncDb.workItemComment.findMany({ orderBy: { githubId: "asc" } });
  return { wi, comments };
}

const strip = <T extends Record<string, unknown>>(row: T, drop: string[] = []) => {
  const out: Record<string, unknown> = { ...row };
  for (const k of ["id", "repositoryId", "workItemId", "syncedAt", ...drop]) delete out[k];
  return out;
};
const repoJson = () => webhook("issues-opened").payload.repository;
const PULL12 = webhook("pull_request-opened").payload.pull_request; // answers GET /pulls/12 when the sync reads a pull request found through its comments
const NOW = new Date("2026-10-30T13:00:00Z");

describe("direct apply writes what the full sync writes", () => {
  it.each(["issues-opened", "issues-edited", "issues-closed"])("%s", async (name) => {
    const { log, deps: d } = deps();
    const e = relay(name);
    await handleGithubEvent(db, e, d);
    const [row] = await items();
    const sync = await fullSync({ repo: repoJson(), items: [e.payload.issue] }, NOW);
    expect(strip(row)).toEqual(strip(sync.wi[0]));
    expect(log.notified).toBe(1);
    expect(log.refreshed).toEqual([]);
  });

  it("issues: labels, assignees, milestone and closed state land as stored by the sync", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("issues-opened"), d);
    expect(await one(7)).toMatchObject({ type: "ISSUE", state: "OPEN", title: "Crash when the config file is empty", authorLogin: "alice", labelNames: expect.stringContaining("bug") });
    await handleGithubEvent(db, relay("issues-edited"), d);
    const edited = await one(7);
    expect(edited).toMatchObject({ title: "Crash when the config file is empty (v1.1)", milestoneNumber: 3, milestoneTitle: "v1.2" });
    expect((edited.labels as { name: string }[]).map((l) => l.name)).toEqual(["bug", "documentation"]);
    expect(edited.assignees).toEqual(["bob"]);
    await handleGithubEvent(db, relay("issues-closed"), d);
    const closed = await one(7);
    expect(closed.state).toBe("CLOSED");
    expect(closed.closedAtGh).toEqual(new Date("2026-10-30T11:00:00Z"));
    expect(closed.assignees).toEqual(["bob", "carol"]);
  });

  it.each(["pull_request-opened", "pull_request-synchronize", "pull_request-closed-merged", "pull_request-ready_for_review"])("%s", async (name) => {
    const { log, deps: d } = deps();
    const e = relay(name);
    await handleGithubEvent(db, e, d);
    const [row] = await items();
    const pr = e.payload.pull_request;
    const sync = await fullSync({ repo: repoJson(), items: [{ ...pr, pull_request: { merged_at: pr.merged_at } }], pulls: [pr] }, NOW);
    // The checks state is not in the payload: the direct apply says PENDING for a new head, the sync asks the API (none here).
    // `mergeable`: a payload with null keeps the stored value (UNKNOWN on a new row), which is what the sync stores for null too.
    // The full sync reads pull request detail only for OPEN pull requests; a merged or closed one keeps whatever PR fields it had.
    // The payload always carries them, so the direct apply stores them too (a superset): compare everything else.
    const prOnly = pr.state === "open" ? [] : ["headSha", "headRef", "baseRef", "additions", "deletions", "changedFiles", "mergeable"];
    expect(strip(row, ["checksState", ...prOnly])).toEqual(strip(sync.wi[0], ["checksState", ...prOnly]));
    expect(row.checksState).toBe("PENDING");
    expect(log.notified).toBe(1);
  });

  it("pull_request: merged is MERGED with its merge time; head and base refs, sha and size counters are stored", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-opened"), d);
    expect(await one(12)).toMatchObject({ type: "PULL_REQUEST", state: "OPEN", draft: false, headRef: "empty-config", baseRef: "main", headSha: "1".repeat(40), additions: 14, deletions: 2, changedFiles: 3, mergeable: "UNKNOWN", checksState: "PENDING" });
    await handleGithubEvent(db, relay("pull_request-closed-merged"), d);
    expect(await one(12)).toMatchObject({ state: "MERGED", mergedAtGh: new Date("2026-10-30T12:00:00Z"), headSha: "2".repeat(40), additions: 40 });
  });

  it("pull_request: mergeable comes from the payload only when it is a boolean; otherwise the stored value is kept", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-ready_for_review"), d); // mergeable: true
    expect((await one(12)).mergeable).toBe("MERGEABLE");
    await handleGithubEvent(db, relay("pull_request-synchronize"), d); // mergeable: null
    expect((await one(12)).mergeable).toBe("MERGEABLE");
    await handleGithubEvent(db, relay("pull_request-closed-merged", { patch: (p) => (p.pull_request.mergeable = false) }), d);
    expect((await one(12)).mergeable).toBe("CONFLICTING");
  });

  it("pull_request: the checks state becomes PENDING only when the head sha changed", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-opened"), d);
    await db.workItem.update({ where: { repositoryId_number: { repositoryId: repoId, number: 12 } }, data: { checksState: "SUCCESS" } });
    await handleGithubEvent(db, relay("pull_request-ready_for_review"), d); // same head sha
    expect((await one(12)).checksState).toBe("SUCCESS");
    await handleGithubEvent(db, relay("pull_request-synchronize"), d); // new head sha
    expect((await one(12)).checksState).toBe("PENDING");
  });

  it("pull_request: merging closes the open review requests, as the full sync does", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-opened"), d);
    const wi = await one(12);
    await db.reviewRequest.create({ data: { workItemId: wi.id, kind: "USER", reviewerRef: "alice", requestedAt: new Date() } });
    await handleGithubEvent(db, relay("pull_request-closed-merged"), d);
    expect(await db.reviewRequest.count({ where: { workItemId: wi.id, removedAt: null } })).toBe(0);
  });

  it.each([
    ["issue_comment-created-issue", "issue_comment-created-issue", 7],
    ["issue_comment-created-pr", "issue_comment-created-pr", 12],
  ])("%s stores the same comment row and creates the missing work item", async (name, _n, number) => {
    const { log, deps: d } = deps();
    const e = relay(name);
    await handleGithubEvent(db, e, d);
    expect(await items()).toHaveLength(1);
    const rows = await db.workItemComment.findMany();
    expect(rows).toHaveLength(1);
    const c = e.payload.comment;
    const sync = await fullSync({ repo: repoJson(), items: [e.payload.issue], issueComments: { [number]: [c] }, pulls: [PULL12] }, NOW);
    // a PR seen only through an issue_comment has no PR fields (the next PR event or sync fills them): compare the comment row
    expect(strip(rows[0])).toEqual(strip(sync.comments[0]));
    expect(rows[0]).toMatchObject({ kind: "ISSUE_COMMENT", githubId: BigInt(c.id), authorLogin: c.user.login, body: c.body });
    expect(log.notified).toBe(1);
  });

  it.each([
    ["issue", "issue_comment-created-issue", "issue_comment-edited-issue", "issue_comment-deleted-issue", 7],
    ["pull request", "issue_comment-created-pr", "issue_comment-edited-pr", "issue_comment-deleted-pr", 12],
  ])("issue_comment created, edited, deleted on a %s", async (_label, created, edited, deleted, number) => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay(created), d);
    const first = await db.workItemComment.findMany();
    expect(first).toHaveLength(1);
    await handleGithubEvent(db, relay(edited), d);
    const after = await db.workItemComment.findMany();
    expect(after).toHaveLength(1);
    expect(after[0].body).toBe(webhook(edited).payload.comment.body);
    expect(after[0].updatedAtGh).toEqual(new Date(webhook(edited).payload.comment.updated_at));
    expect(after[0].createdAtGh).toEqual(first[0].createdAtGh);
    // the edit must equal what a full sync stores for the edited comment
    const sync = await fullSync({ repo: repoJson(), items: [webhook(edited).payload.issue], issueComments: { [number]: [webhook(edited).payload.comment] }, pulls: [PULL12] }, NOW);
    expect(strip(after[0])).toEqual(strip(sync.comments[0]));
    await handleGithubEvent(db, relay(deleted), d);
    expect(await db.workItemComment.count()).toBe(0);
    expect(await items()).toHaveLength(1); // the work item stays
  });

  it("pull_request_review_comment created stores path, line, commit sha and thread key like the sync, and creates the pull request", async () => {
    const { log, deps: d } = deps();
    const e = relay("pull_request_review_comment-created");
    await handleGithubEvent(db, e, d);
    const [pr] = await items();
    expect(pr).toMatchObject({ number: 12, type: "PULL_REQUEST", headRef: "empty-config" });
    const rows = await db.workItemComment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "REVIEW_COMMENT", path: "src/config.go", line: 13, commitSha: "1".repeat(40), threadKey: "8000001", authorLogin: "alice" });
    const pull = e.payload.pull_request;
    const sync = await fullSync({ repo: repoJson(), items: [{ ...pull, pull_request: { merged_at: null } }], pulls: [pull], reviewComments: { 12: [e.payload.comment] } }, NOW);
    expect(strip(rows[0])).toEqual(strip(sync.comments[0]));
    expect(log.notified).toBe(1);
    // a reply keeps the thread key of the comment it answers
    await handleGithubEvent(db, relay("pull_request_review_comment-reply-created"), d);
    const reply = await db.workItemComment.findFirstOrThrow({ where: { githubId: 8000002n } });
    expect(reply.threadKey).toBe("8000001");
    expect(await db.workItemComment.count()).toBe(2);
  });

  it("a review comment is removed when GitHub deletes it", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request_review_comment-created"), d);
    await handleGithubEvent(db, relay("pull_request_review_comment-created", { patch: (p) => (p.action = "deleted") }), d);
    expect(await db.workItemComment.count()).toBe(0);
  });
});

describe("never backwards in time", () => {
  it("an older updated_at does not overwrite a newer row", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("issues-edited"), d); // 10:00
    await handleGithubEvent(db, relay("issues-opened"), d); // 09:00, delivered late
    expect(await one(7)).toMatchObject({ title: "Crash when the config file is empty (v1.1)", updatedAtGh: new Date("2026-10-30T10:00:00Z") });
    expect(log.notified).toBe(1); // the stale write changed nothing
    expect(log.refreshed).toEqual([]);
  });

  it("an older pull request payload does not overwrite a newer row either", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-closed-merged"), d); // 12:00
    await handleGithubEvent(db, relay("pull_request-synchronize"), d); // 10:15
    expect(await one(12)).toMatchObject({ state: "MERGED", headSha: "2".repeat(40) });
  });

  it("an older comment edit does not overwrite a newer comment", async () => {
    const { deps: d } = deps();
    await handleGithubEvent(db, relay("issue_comment-edited-issue"), d); // 09:20
    await handleGithubEvent(db, relay("issue_comment-created-issue"), d); // 09:10
    expect((await db.workItemComment.findFirstOrThrow()).body).toBe("I can reproduce this on Windows and macOS.");
  });
});

describe("fallback", () => {
  const rowsWritten = async () => (await items()).length + (await db.workItemComment.count());

  it.each(["pull_request_review", "pull_request_review_thread", "check_run", "check_suite", "status", "push", "create", "delete"])("%s asks for a refresh and writes nothing", async (event) => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, { repoId: REPO_ID, event, delivery: `d-${event}`, payload: { action: "x", repository: repoJson() } }, d);
    expect(log.refreshed).toEqual([repoId]);
    expect(log.notified).toBe(0);
    expect(await rowsWritten()).toBe(0);
  });

  it("review_requested and review_request_removed fall back, other pull_request actions do not", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("pull_request-review_requested"), d);
    await handleGithubEvent(db, relay("pull_request-review_requested", { patch: (p) => (p.action = "review_request_removed") }), d);
    expect(log.refreshed).toEqual([repoId, repoId]);
    expect(await rowsWritten()).toBe(0);
    await handleGithubEvent(db, relay("pull_request-opened"), d);
    expect(log.refreshed).toHaveLength(2);
  });

  it("an unknown event falls back", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, { repoId: REPO_ID, event: "something_new", delivery: "d1", payload: { action: "created" } }, d);
    expect(log.refreshed).toEqual([repoId]);
  });

  it("a null payload (too large for the hub to relay) falls back even for a direct-apply event", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("issues-opened", { payload: null }), d);
    expect(log.refreshed).toEqual([repoId]);
    expect(await rowsWritten()).toBe(0);
  });

  const broken: [string, string, (p: any) => void][] = [
    ["issue without a title", "issues-opened", (p) => delete p.issue.title],
    ["issue number as a string", "issues-opened", (p) => (p.issue.number = "7")],
    ["issue without dates", "issues-opened", (p) => delete p.issue.updated_at],
    ["issue with an unparsable date", "issues-opened", (p) => (p.issue.created_at = "yesterday")],
    ["issue state unknown", "issues-opened", (p) => (p.issue.state = "weird")],
    ["labels not a list", "issues-opened", (p) => (p.issue.labels = "bug")],
    ["issue is null", "issues-opened", (p) => (p.issue = null)],
    ["an issues event whose issue is a pull request", "issues-opened", (p) => (p.issue.pull_request = { url: "x" })],
    ["payload without an action", "issues-opened", (p) => delete p.action],
    ["pull request without a head", "pull_request-opened", (p) => delete p.pull_request.head],
    ["pull request additions as a string", "pull_request-opened", (p) => (p.pull_request.additions = "many")],
    ["pull_request not an object", "pull_request-opened", (p) => (p.pull_request = 12)],
    ["comment without an id", "issue_comment-created-issue", (p) => delete p.comment.id],
    ["comment body a number", "issue_comment-created-issue", (p) => (p.comment.body = 5)],
    ["comment action unknown", "issue_comment-created-issue", (p) => (p.action = "pinned")],
    ["review comment line a string", "pull_request_review_comment-created", (p) => (p.comment.line = "13")],
    ["review comment without its pull request", "pull_request_review_comment-created", (p) => delete p.pull_request],
  ];
  it.each(broken)("%s falls back without throwing and writes nothing", async (_label, name, patch) => {
    const { log, deps: d } = deps();
    await expect(handleGithubEvent(db, relay(name, { patch }), d)).resolves.toBeUndefined();
    expect(log.refreshed).toEqual([repoId]);
    expect(log.notified).toBe(0);
    expect(await rowsWritten()).toBe(0);
  });

  it("garbage payloads (string, array, number) fall back", async () => {
    const { log, deps: d } = deps();
    for (const payload of ["x", [1], 5, true]) await handleGithubEvent(db, { repoId: REPO_ID, event: "issues", delivery: `g-${String(payload)}`, payload }, d);
    expect(log.refreshed).toHaveLength(4);
  });

  it("a malformed event never blocks the next one", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("issues-opened", { patch: (p) => delete p.issue.title }), d);
    await handleGithubEvent(db, relay("issues-opened"), d);
    expect(await items()).toHaveLength(1);
    expect(log.notified).toBe(1);
  });

  it("a failing database never throws out of the handler", async () => {
    const bad = { repository: { findMany: () => Promise.reject(new Error("disk full")) } } as unknown as Db;
    await expect(handleGithubEvent(bad, relay("issues-opened"), deps().deps)).resolves.toBeUndefined();
    await expect(handleGithubEvent(bad, null as unknown as GithubEvent, deps().deps)).resolves.toBeUndefined();
  });

  it("a failing write falls back to a refresh", async () => {
    const { log, deps: d } = deps();
    const failing = new Proxy(db, { get: (t, k) => (k === "workItem" ? { ...t.workItem, findUnique: () => Promise.reject(new Error("locked")) } : (t as never)[k]) }) as Db;
    await handleGithubEvent(failing, relay("issues-opened"), d);
    expect(log.refreshed).toEqual([repoId]);
  });
});

describe("which events are applied", () => {
  it("a delivery id seen twice applies once", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("issues-opened", { delivery: "same" }), d);
    await handleGithubEvent(db, relay("issues-edited", { delivery: "same" }), d);
    expect((await one(7)).title).toBe("Crash when the config file is empty");
    expect(log.notified).toBe(1);
  });

  it("a duplicate fallback delivery asks for one refresh", async () => {
    const { log, deps: d } = deps();
    const e: GithubEvent = { repoId: REPO_ID, event: "check_run", delivery: "dup", payload: { action: "completed" } };
    await handleGithubEvent(db, e, d);
    await handleGithubEvent(db, e, d);
    expect(log.refreshed).toHaveLength(1);
  });

  it("only the last 200 delivery ids are remembered", async () => {
    const { log, deps: d } = deps();
    const ev = (i: number): GithubEvent => ({ repoId: REPO_ID, event: "check_run", delivery: `bulk-${i}`, payload: {} });
    for (let i = 0; i < 201; i++) await handleGithubEvent(db, ev(i), d);
    expect(log.refreshed).toHaveLength(201);
    await handleGithubEvent(db, ev(200), d); // still remembered
    expect(log.refreshed).toHaveLength(201);
    await handleGithubEvent(db, ev(0), d); // evicted
    expect(log.refreshed).toHaveLength(202);
  });

  it("events for a repository that is not tracked are ignored, and do not use up the delivery id", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, { ...relay("issues-opened", { delivery: "x1" }), repoId: "42" }, d);
    expect(log.notified + log.refreshed.length).toBe(0);
    expect(await items()).toHaveLength(0);
    // not an id at all
    await handleGithubEvent(db, { ...relay("issues-opened"), repoId: "abc" }, d);
    expect(log.notified + log.refreshed.length).toBe(0);
  });

  it.each(["REMOVED", "DISCONNECTED"] as const)("a %s repository is ignored", async (status) => {
    const { log, deps: d } = deps();
    await db.repository.update({ where: { id: repoId }, data: { trackingStatus: status } });
    await handleGithubEvent(db, relay("issues-opened"), d);
    await handleGithubEvent(db, { repoId: REPO_ID, event: "push", delivery: "p1", payload: {} }, d);
    expect(log.notified + log.refreshed.length).toBe(0);
    expect(await items()).toHaveLength(0);
  });

  it("notifies after an apply and only then", async () => {
    const { log, deps: d } = deps();
    await handleGithubEvent(db, relay("issues-opened"), d);
    expect(log.notified).toBe(1);
    await handleGithubEvent(db, relay("issue_comment-created-issue"), d);
    expect(log.notified).toBe(2);
    await handleGithubEvent(db, { repoId: REPO_ID, event: "check_run", delivery: "c1", payload: {} }, d);
    expect(log.notified).toBe(2);
  });
});
