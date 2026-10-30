import { Octokit } from "octokit";
const MAX_TEXT_BYTES = 1_000_000;
import type { RepoMeta } from "@/lib/services/repositories";
import type { CompareOutcome } from "@/lib/domain/forks";
import {
  GithubError,
  type Contents,
  type Discovery,
  type DiscoveryNote,
  type GithubPort,
  type MergeMethod,
  type Page,
  type RateInfo,
  type RemoteBranch,
  type RemoteComment,
  type RemoteRequested,
  type RemoteReview,
  type RemoteWorkItem,
  type TreeEntry,
} from "./port";

export type CacheStore = {
  get(key: string): Promise<{ etag: string | null; body: unknown } | null>;
  set(key: string, etag: string | null, body: unknown): Promise<void>;
};

export type OctokitPortOptions = {
  /** Optional ETag cache. Conditional requests answered 304 do not spend rate limit. */
  cache?: CacheStore;
  onRate?: (r: RateInfo) => void;
  /** Used to build "additional authorization required" links. */
  appInstallUrl?: string;
  fetch?: typeof fetch;
};

export function createOctokit(auth: string | undefined, fetchImpl?: typeof fetch): Octokit {
  return new Octokit({
    auth,
    // We surface rate limits to the caller instead of sleeping inside a request; the job queue backs off.
    throttle: { onRateLimit: () => false, onSecondaryRateLimit: () => false },
    retry: { enabled: false },
    request: fetchImpl ? { fetch: fetchImpl } : undefined,
    userAgent: "mergeport",
  });
}

const date = (s: string | null | undefined) => (s ? new Date(s) : null);

function mapError(e: any): GithubError {
  const status: number | undefined = e?.status;
  const headers = e?.response?.headers ?? {};
  const msg = String(e?.response?.data?.message ?? e?.message ?? "GitHub request failed");
  const reset = headers["x-ratelimit-reset"] ? new Date(Number(headers["x-ratelimit-reset"]) * 1000) : undefined;
  const retryAfter = headers["retry-after"] ? Number(headers["retry-after"]) : undefined;
  if (status === 403 || status === 429) {
    const remaining = headers["x-ratelimit-remaining"];
    if (retryAfter || remaining === "0" || /rate limit/i.test(msg) || status === 429) return new GithubError("rate-limited", msg, retryAfter ?? (reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60), reset);
    if (/SAML|SSO/i.test(msg) || headers["x-github-sso"]) return new GithubError("sso", "SAML SSO authorization is required for this organization");
    return new GithubError("forbidden", msg);
  }
  // The profile's own account could not be used (bound.ts): keep the specific, actionable reason.
  if (headers["x-mergeport-identity"]) return new GithubError("auth", String(e?.response?.data?.message ?? "Reconnect the GitHub account for this profile."), undefined, undefined, 401);
  if (status === 401) return new GithubError("auth", "The GitHub credential is no longer valid");
  if (status === 404) return new GithubError("not-found", "Not found, or not accessible with this connection");
  if (status === undefined) return new GithubError("network", msg);
  // Octokit reports a fetch that never got an HTTP response (offline, DNS, a stalled or killed gh) as a 500 carrying the transport's message.
  if (status === 500 && /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|timed out|did not answer/i.test(String(e?.message))) return new GithubError("network", "Could not reach GitHub");
  return new GithubError("unknown", `${status}: ${msg}`);
}

type Stored = { __mp: 1; data: unknown; link: string | null };
const isStored = (b: unknown): b is Stored => !!b && typeof b === "object" && (b as { __mp?: unknown }).__mp === 1;

export class OctokitPort implements GithubPort {
  readonly mode = "live" as const;
  private rate: RateInfo | null = null;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ok: Octokit,
    private readonly opts: OctokitPortOptions = {},
  ) {}

  lastRate() {
    return this.rate;
  }

  private note(headers: Record<string, string | undefined> | undefined) {
    if (!headers?.["x-ratelimit-remaining"]) return;
    this.rate = { remaining: Number(headers["x-ratelimit-remaining"]), limit: Number(headers["x-ratelimit-limit"] ?? 0), resetAt: new Date(Number(headers["x-ratelimit-reset"] ?? 0) * 1000) };
    this.opts.onRate?.(this.rate);
  }

  /** GET with ETag caching and in-process coalescing of identical concurrent requests. */
  private async get<T>(route: string, params: Record<string, unknown> = {}): Promise<{ data: T; headers: Record<string, string | undefined> }> {
    const key = route + " " + JSON.stringify(params);
    const existing = this.inflight.get(key) as Promise<{ data: T; headers: Record<string, string | undefined> }> | undefined;
    if (existing) return existing;
    const p = (async () => {
      // A cached page is only usable if it kept its Link header: GitHub's 304 carries none, and without it pagination silently
      // stops after the first page (a repository would look "synchronized" with most of its items missing). Older cache
      // entries without the header are refetched in full.
      const raw = this.opts.cache ? await this.opts.cache.get(key) : null;
      const cached = raw && isStored(raw.body) ? { etag: raw.etag, stored: raw.body } : null;
      try {
        const res = await this.ok.request(route, { ...params, headers: cached?.etag ? { "if-none-match": cached.etag } : {} });
        this.note(res.headers as any);
        const etag = (res.headers as any).etag ?? null;
        if (this.opts.cache && etag) await this.opts.cache.set(key, etag, { __mp: 1, data: res.data, link: ((res.headers as any).link as string | undefined) ?? null } satisfies Stored);
        return { data: res.data as T, headers: res.headers as any };
      } catch (e: any) {
        if (e?.status === 304 && cached) {
          this.note(e.response?.headers);
          return { data: cached.stored.data as T, headers: { ...(e.response?.headers ?? {}), ...(cached.stored.link ? { link: cached.stored.link } : {}) } };
        }
        throw mapError(e);
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async send<T>(route: string, params: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.ok.request(route, params);
      this.note(res.headers as any);
      return res.data as T;
    } catch (e) {
      throw mapError(e);
    }
  }

  private static nextPage(link: string | undefined): number | null {
    const m = link && /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(link);
    return m ? Number(m[1]) : null;
  }

  static toRepoMeta(r: any): RepoMeta {
    return {
      githubId: BigInt(r.id),
      fullName: r.full_name,
      name: r.name,
      htmlUrl: r.html_url,
      description: r.description ?? null,
      visibility: r.visibility ? (String(r.visibility).toUpperCase() as RepoMeta["visibility"]) : r.private ? "PRIVATE" : "PUBLIC",
      isFork: !!r.fork,
      parentGithubId: r.parent?.id ? BigInt(r.parent.id) : null,
      parentFullName: r.parent?.full_name ?? null,
      defaultBranch: r.default_branch ?? null,
      archived: !!r.archived,
      // Account type comes from the API (owner.type), never from the name.
      owner: { githubId: BigInt(r.owner.id), login: r.owner.login, type: r.owner.type === "Organization" ? "ORGANIZATION" : r.owner.type === "User" ? "USER" : "UNKNOWN", avatarUrl: r.owner.avatar_url ?? null },
      permissions: r.permissions ?? null,
    };
  }

  async getRepository(owner: string, repo: string) {
    const { data } = await this.get<any>("GET /repos/{owner}/{repo}", { owner, repo });
    return OctokitPort.toRepoMeta(data);
  }

  /**
   * Discovery lists what THIS account's gh authorization can actually enumerate: owned, collaborator and organization
   * repositories, page by page. It never claims to show everything visible on github.com: organization policies and
   * SAML SSO can hide repositories until the person authorizes the token for that organization, and public
   * repositories of others only appear when the person is a collaborator.
   */
  async listAuthorizedRepositories(page: number): Promise<Discovery> {
    const { data, headers } = await this.get<any[]>("GET /user/repos", { affiliation: "owner,collaborator,organization_member", sort: "updated", per_page: 100, page });
    const notes: DiscoveryNote[] = [];
    if (page === 1 && headers["x-github-sso"]) notes.push({ kind: "org-approval", ownerLogin: "", message: "Some organizations require SAML SSO authorization for your gh token before their repositories can be listed. Authorize the token for those organizations on GitHub, then refresh." });
    return { repos: data.map(OctokitPort.toRepoMeta), nextPage: OctokitPort.nextPage(headers.link), notes };
  }

  async listIssuesAndPulls(owner: string, repo: string, o: { since?: Date; page: number }): Promise<Page<RemoteWorkItem>> {
    // The issues endpoint returns issues AND pull requests; each item appears once, keyed by number.
    const { data, headers } = await this.get<any[]>("GET /repos/{owner}/{repo}/issues", { owner, repo, state: "all", sort: "updated", direction: "desc", per_page: 100, page: o.page, ...(o.since ? { since: o.since.toISOString() } : {}) });
    return { items: data.map(OctokitPort.toWorkItem), nextPage: OctokitPort.nextPage(headers.link), rate: this.rate ?? undefined };
  }

  static toWorkItem(i: any): RemoteWorkItem {
    const isPr = !!i.pull_request;
    const merged = !!(i.pull_request?.merged_at);
    return {
      githubId: BigInt(i.id),
      number: i.number,
      type: isPr ? "PULL_REQUEST" : "ISSUE",
      title: i.title,
      body: i.body ?? null,
      state: merged ? "MERGED" : i.state === "closed" ? "CLOSED" : "OPEN",
      draft: !!i.draft,
      authorLogin: i.user?.login ?? null,
      authorGithubId: i.user?.id ? BigInt(i.user.id) : null,
      authorAvatar: i.user?.avatar_url ?? null,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? { name: l, color: "ededed" } : { name: l.name, color: l.color ?? "ededed" })),
      assignees: (i.assignees ?? []).map((a: any) => a.login),
      milestoneNumber: i.milestone?.number ?? null,
      milestoneTitle: i.milestone?.title ?? null,
      htmlUrl: i.html_url,
      createdAt: new Date(i.created_at),
      updatedAt: new Date(i.updated_at),
      closedAt: date(i.closed_at),
      mergedAt: date(i.pull_request?.merged_at),
    };
  }

  async getPull(owner: string, repo: string, number: number) {
    const { data } = await this.get<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
    return OctokitPort.toPull(data);
  }

  /** A REST pull request object (also the `pull_request` object of a webhook payload, which has the same shape) as a work item with the PR fields. */
  static toPull(data: any) {
    const base = OctokitPort.toWorkItem({ ...data, pull_request: { merged_at: data.merged_at } });
    return {
      ...base,
      state: data.merged ? ("MERGED" as const) : data.state === "closed" ? ("CLOSED" as const) : ("OPEN" as const),
      draft: !!data.draft,
      headSha: data.head?.sha ?? null,
      headRef: data.head?.ref ?? null,
      baseRef: data.base?.ref ?? null,
      // GitHub computes mergeability lazily: null means "not computed yet", never "mergeable".
      mergeable: data.mergeable === true ? ("MERGEABLE" as const) : data.mergeable === false ? ("CONFLICTING" as const) : ("UNKNOWN" as const),
      additions: data.additions ?? null,
      deletions: data.deletions ?? null,
      changedFiles: data.changed_files ?? null,
    };
  }

  /** A REST issue comment (or the `comment` object of an `issue_comment` webhook). */
  static toComment(c: any): RemoteComment {
    return { githubId: BigInt(c.id), login: c.user?.login ?? null, body: c.body ?? null, createdAt: new Date(c.created_at), updatedAt: new Date(c.updated_at) };
  }

  /** A REST pull request review comment (or the `comment` object of a `pull_request_review_comment` webhook). */
  static toReviewComment(c: any): RemoteComment {
    return { ...OctokitPort.toComment(c), path: c.path ?? null, line: c.line ?? c.original_line ?? null, commitSha: c.commit_id ?? null, threadKey: String(c.in_reply_to_id ?? c.id) };
  }

  private async paginate<T>(route: string, params: Record<string, unknown>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 30; page++) {
      const { data, headers } = await this.get<T[]>(route, { ...params, per_page: 100, page });
      out.push(...data);
      if (!OctokitPort.nextPage(headers.link)) break;
    }
    return out;
  }

  async listReviews(owner: string, repo: string, number: number): Promise<RemoteReview[]> {
    const rows = await this.paginate<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: number });
    return rows.map((r) => ({ githubId: BigInt(r.id), login: r.user?.login ?? null, state: r.state as RemoteReview["state"], body: r.body ?? null, commitSha: r.commit_id ?? null, submittedAt: new Date(r.submitted_at ?? Date.now()) }));
  }

  async listIssueComments(owner: string, repo: string, number: number): Promise<RemoteComment[]> {
    const rows = await this.paginate<any>("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: number });
    return rows.map(OctokitPort.toComment);
  }

  async listReviewComments(owner: string, repo: string, number: number): Promise<RemoteComment[]> {
    const rows = await this.paginate<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", { owner, repo, pull_number: number });
    return rows.map(OctokitPort.toReviewComment);
  }

  async listRequestedReviewers(owner: string, repo: string, number: number): Promise<RemoteRequested> {
    const { data } = await this.get<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { owner, repo, pull_number: number });
    return { users: (data.users ?? []).map((u: any) => u.login), teams: (data.teams ?? []).map((t: any) => t.slug) };
  }

  async getChecksState(owner: string, repo: string, sha: string) {
    try {
      const { data } = await this.get<any>("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { owner, repo, ref: sha, per_page: 100 });
      const runs: any[] = data.check_runs ?? [];
      if (runs.length === 0) return "NONE" as const;
      if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled" || r.conclusion === "action_required")) return "FAILURE" as const;
      if (runs.some((r) => r.status !== "completed")) return "PENDING" as const;
      return "SUCCESS" as const;
    } catch (e) {
      if (e instanceof GithubError && (e.kind === "forbidden" || e.kind === "not-found")) return "UNKNOWN" as const; // checks permission may be missing
      throw e;
    }
  }

  async listBranches(owner: string, repo: string): Promise<RemoteBranch[]> {
    const info = await this.get<any>("GET /repos/{owner}/{repo}", { owner, repo });
    const rows = await this.paginate<any>("GET /repos/{owner}/{repo}/branches", { owner, repo });
    return rows.map((b) => ({ name: b.name, sha: b.commit.sha, isDefault: b.name === info.data.default_branch }));
  }

  async listPullFiles(owner: string, repo: string, number: number) {
    const { data, headers } = await this.get<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", { owner, repo, pull_number: number, per_page: 100 });
    const more = OctokitPort.nextPage(headers.link) !== null;
    return { files: data.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null, previousFilename: f.previous_filename ?? null })), truncated: more };
  }

  async getContents(owner: string, repo: string, path: string, ref?: string): Promise<Contents> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const route = clean ? "GET /repos/{owner}/{repo}/contents/{path}" : "GET /repos/{owner}/{repo}/contents";
    const { data } = await this.get<any>(route, { owner, repo, ...(clean ? { path: clean } : {}), ...(ref ? { ref } : {}) });
    if (Array.isArray(data)) {
      const entries: TreeEntry[] = data.map((e) => ({ name: e.name, path: e.path, type: e.type === "dir" ? "dir" : e.type === "submodule" ? "submodule" : e.type === "symlink" ? "symlink" : "file", size: e.size ?? 0, sha: e.sha }));
      entries.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return { kind: "dir", entries };
    }
    const size = Number(data.size ?? 0);
    const file = { path: data.path as string, sha: data.sha as string, size, htmlUrl: (data.html_url as string | undefined) ?? null };
    if (size > MAX_TEXT_BYTES) return { kind: "file", file: { ...file, text: null, binary: false, tooLarge: true } };
    let buf: Buffer;
    if (data.encoding === "base64" && typeof data.content === "string") buf = Buffer.from(data.content, "base64");
    else {
      const raw = await this.send<ArrayBuffer | string>(route, { owner, repo, ...(clean ? { path: clean } : {}), ...(ref ? { ref } : {}), headers: { accept: "application/vnd.github.raw+json" } });
      buf = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
    }
    if (buf.subarray(0, 8000).includes(0)) return { kind: "file", file: { ...file, text: null, binary: true, tooLarge: false } };
    return { kind: "file", file: { ...file, text: buf.toString("utf8"), binary: false, tooLarge: false } };
  }

  async listCommitFiles(owner: string, repo: string, sha: string) {
    const { data } = await this.get<any>("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref: sha, per_page: 100 });
    const files: any[] = data.files ?? [];
    return { files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch ?? null, previousFilename: f.previous_filename ?? null })), truncated: files.length >= 300 };
  }

  async createReviewComment(owner: string, repo: string, number: number, i: { body: string; commitSha: string; path: string; line: number; side: "LEFT" | "RIGHT" }): Promise<RemoteComment> {
    const c = await this.send<any>("POST /repos/{owner}/{repo}/pulls/{pull_number}/comments", { owner, repo, pull_number: number, body: i.body, commit_id: i.commitSha, path: i.path, line: i.line, side: i.side });
    return { githubId: BigInt(c.id), login: c.user?.login ?? null, body: c.body, createdAt: new Date(c.created_at), updatedAt: new Date(c.updated_at), path: c.path, line: c.line ?? null, commitSha: c.commit_id ?? null };
  }

  async listPullCommits(owner: string, repo: string, number: number) {
    const { data, headers } = await this.get<any[]>("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", { owner, repo, pull_number: number, per_page: 100 });
    const more = OctokitPort.nextPage(headers.link) !== null;
    return { commits: data.map((c) => { const full = String(c.commit?.message ?? ""); const [first, ...rest] = full.split(/\r?\n/); return { sha: c.sha, message: first, body: rest.join("\n").trim(), author: c.author?.login ?? c.commit?.author?.name ?? null, authorAvatar: c.author?.avatar_url ?? null, date: c.commit?.author?.date ? new Date(c.commit.author.date) : null }; }), truncated: more };
  }

  async compare(upstream: { owner: string; repo: string; branch: string }, fork: { owner: string; branch: string }): Promise<CompareOutcome> {
    try {
      // BASE = upstream branch, HEAD = `forkOwner:forkBranch` (same repository network).
      const basehead = `${encodeURIComponent(upstream.branch)}...${encodeURIComponent(fork.owner)}:${encodeURIComponent(fork.branch)}`;
      const { data } = await this.get<any>("GET /repos/{owner}/{repo}/compare/{basehead}", { owner: upstream.owner, repo: upstream.repo, basehead, per_page: 1 });
      // The compare endpoint lists at most 250 commits; counts stay exact, the listing is what truncates.
      return { kind: "ok", data: { status: data.status === "ahead" || data.status === "behind" || data.status === "identical" ? data.status : "diverged", ahead_by: data.ahead_by, behind_by: data.behind_by, total_commits: data.total_commits, commits_returned: Math.min(data.total_commits, 250), base_sha: data.base_commit?.sha ?? "", head_sha: "" } };
    } catch (e) {
      if (e instanceof GithubError) {
        if (e.kind === "not-found") return { kind: "not-found" };
        if (e.kind === "forbidden") return { kind: "forbidden" };
        if (e.kind === "rate-limited") return { kind: "rate-limited" };
        return { kind: "error", message: e.message };
      }
      if ((e as any)?.message && /No common ancestor/i.test((e as any).message)) return { kind: "no-common-ancestor" };
      return { kind: "error", message: String((e as any)?.message ?? e) };
    }
  }

  async isAncestor(repo: { owner: string; repo: string }, sha: string, branchTip: string) {
    try {
      // compare sha...tip: tip is "ahead" or "identical" iff sha is an ancestor of tip.
      const { data } = await this.get<any>("GET /repos/{owner}/{repo}/compare/{basehead}", { owner: repo.owner, repo: repo.repo, basehead: `${sha}...${branchTip}`, per_page: 1 });
      return data.status === "ahead" || data.status === "identical" ? ("ancestor" as const) : ("not-ancestor" as const);
    } catch {
      return "unknown" as const;
    }
  }

  async getPullMergeSha(owner: string, repo: string, number: number) {
    const { data } = await this.get<any>("GET /repos/{owner}/{repo}/pulls/{pull_number}", { owner, repo, pull_number: number });
    return data.merge_commit_sha ?? null;
  }

  // ---------- writes (acting user's credential) ----------

  async createIssue(owner: string, repo: string, input: { title: string; body?: string; labels?: string[] }) {
    const data = await this.send<any>("POST /repos/{owner}/{repo}/issues", { owner, repo, ...input });
    return OctokitPort.toWorkItem(data);
  }
  async createComment(owner: string, repo: string, number: number, body: string): Promise<RemoteComment> {
    const c = await this.send<any>("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", { owner, repo, issue_number: number, body });
    return { githubId: BigInt(c.id), login: c.user?.login ?? null, body: c.body, createdAt: new Date(c.created_at), updatedAt: new Date(c.updated_at) };
  }
  async setLabels(owner: string, repo: string, number: number, labels: string[]) {
    await this.send("PUT /repos/{owner}/{repo}/issues/{issue_number}/labels", { owner, repo, issue_number: number, labels });
  }
  async setAssignees(owner: string, repo: string, number: number, assignees: string[]) {
    await this.send("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: number, assignees });
  }
  async setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null) {
    await this.send("PATCH /repos/{owner}/{repo}/issues/{issue_number}", { owner, repo, issue_number: number, milestone: milestoneNumber });
  }
  async requestReviewers(owner: string, repo: string, number: number, r: { users?: string[]; teams?: string[] }) {
    await this.send("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", { owner, repo, pull_number: number, reviewers: r.users ?? [], team_reviewers: r.teams ?? [] });
  }
  async submitReview(owner: string, repo: string, number: number, input: { event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; body?: string; commitSha?: string }) {
    await this.send("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner, repo, pull_number: number, event: input.event, body: input.body, commit_id: input.commitSha });
  }
  async mergePull(owner: string, repo: string, number: number, input: { method: MergeMethod; expectedHeadSha: string }) {
    // `sha` makes GitHub refuse the merge if the head moved after the user confirmed.
    const r = await this.send<any>("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", { owner, repo, pull_number: number, merge_method: input.method, sha: input.expectedHeadSha });
    return { merged: !!r.merged, message: String(r.message ?? "") };
  }
  async mergeUpstream(owner: string, repo: string, branch: string) {
    try {
      const r = await this.send<any>("POST /repos/{owner}/{repo}/merge-upstream", { owner, repo, branch });
      const t = String(r.merge_type ?? "");
      return { result: t === "fast-forward" ? ("fast-forward" as const) : t === "none" ? ("up-to-date" as const) : ("merged" as const), message: String(r.message ?? "") };
    } catch (e) {
      if (e instanceof GithubError && e.kind === "unknown" && /409/.test(e.message)) return { result: "conflict" as const, message: "The branches conflict; nothing was changed. Resolve it on GitHub." };
      throw e;
    }
  }
}
