import type { Db } from "@/lib/db";
import { ghFetch } from "@/lib/github/gh";
import { GitHubRest } from "@/lib/github/rest";
import { profileRunner } from "@/lib/local/profile-runner";
import { installUrl } from "@/lib/hub/webhook-panel";
import { GithubError } from "@/lib/github/port";
import { fromJson, toJson } from "@/lib/local/discovery";

/**
 * Installing the team's GitHub App on this person's tracked repositories through their own `gh` (scope `repo`), one request
 * each and only when they press "Add my tracked repositories":
 *   GET  /user/installations                                      (filtered by app_slug)
 *   GET  /user/installations/{installation_id}/repositories
 *   PUT  /user/installations/{installation_id}/repositories/{repository_id}   for tracked repositories not yet covered
 * A 403 or 404 on the PUT (the installation is on "All repositories", or the person does not own the repository) is reported
 * for that repository so the page can send them to the App's install page.
 */
export type TrackedRepo = { githubId: string; fullName: string };

export type InstallReport = {
  appSlug: string;
  installUrl: string;
  /** `not-installed`: the person has not installed the App at all. `cannot-list`: GitHub would not tell this credential. */
  state: "checked" | "not-installed" | "cannot-list";
  /** GitHub ids (decimal) of the tracked repositories the App covers after this run. */
  covered: string[];
  /** Full names of the repositories added by this run. */
  added: string[];
  /** Full names that need the App installed on GitHub by hand (403/404, or no installation on that owner's account). */
  failed: { fullName: string; status: 403 | 404 | null }[];
};

/** GitHub REST as THIS profile's own account (through its bound `gh`), the same way the sync builds it. */
export const profileRest = (db: Db) => new GitHubRest(ghFetch(profileRunner(db)));

export { installUrl };

type Installation = { id: number; app_slug?: string; account?: { login?: string } | null };
const MAX_PAGES = 20;

/** Pages of `{ <key>: [...] }` bodies (GitHub wraps these lists in an object, so `GitHubRest.paginate` does not apply). */
async function pages<T>(rest: GitHubRest, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await rest.get<Record<string, unknown>>(`${path}?per_page=100&page=${page}`);
    const list = r.data?.[key];
    if (!Array.isArray(list)) break;
    out.push(...(list as T[]));
    if (list.length < 100) break;
  }
  return out;
}

export async function addTrackedRepositories(rest: GitHubRest, appSlug: string, tracked: TrackedRepo[]): Promise<InstallReport> {
  const base = { appSlug, installUrl: installUrl(appSlug) };
  let installations: Installation[];
  try {
    installations = (await pages<Installation>(rest, "/user/installations", "installations")).filter((i) => i.app_slug === appSlug && typeof i.id === "number");
  } catch (e) {
    if (e instanceof GithubError && (e.kind === "forbidden" || e.kind === "not-found" || e.kind === "auth")) return { ...base, state: "cannot-list", covered: [], added: [], failed: [] };
    throw e;
  }
  if (installations.length === 0) return { ...base, state: "not-installed", covered: [], added: [], failed: [] };

  const coveredIds = new Set<string>();
  for (const i of installations) {
    for (const r of await pages<{ id?: number }>(rest, `/user/installations/${i.id}/repositories`, "repositories")) if (typeof r.id === "number") coveredIds.add(String(r.id));
  }

  const added: string[] = [];
  const failed: InstallReport["failed"] = [];
  for (const repo of tracked) {
    if (coveredIds.has(repo.githubId)) continue;
    const owner = repo.fullName.split("/")[0]?.toLowerCase();
    const target = installations.find((i) => i.account?.login?.toLowerCase() === owner);
    if (!target) {
      failed.push({ fullName: repo.fullName, status: null });
      continue;
    }
    try {
      await rest.request("PUT", `/user/installations/${target.id}/repositories/${encodeURIComponent(repo.githubId)}`);
      added.push(repo.fullName);
      coveredIds.add(repo.githubId);
    } catch (e) {
      if (e instanceof GithubError && (e.status === 403 || e.status === 404)) failed.push({ fullName: repo.fullName, status: e.status });
      else throw e;
    }
  }
  return { ...base, state: "checked", covered: tracked.filter((t) => coveredIds.has(t.githubId)).map((t) => t.githubId), added, failed };
}

/** The last result, kept in the profile's local database so pages show it without asking GitHub. */
export const COVERAGE_KEY = "github-app-coverage";
export type StoredCoverage = { appSlug: string; checkedAt: string; covered: string[] };

export async function saveCoverage(db: Db, c: StoredCoverage): Promise<void> {
  const data = { payload: toJson(c), fetchedAt: new Date(c.checkedAt), state: "FRESH", error: null, attempts: 0, nextRetryAt: null };
  await db.discoveryCache.upsert({ where: { key: COVERAGE_KEY }, create: { key: COVERAGE_KEY, ...data }, update: data });
}

export async function clearCoverage(db: Db): Promise<void> {
  await db.discoveryCache.deleteMany({ where: { key: COVERAGE_KEY } });
}

/** GitHub ids (decimal) of repositories the App was last seen to cover; empty when never checked or when the App's slug changed. */
export async function readCoverage(db: Db, appSlug?: string | null): Promise<Set<string>> {
  const row = await db.discoveryCache.findUnique({ where: { key: COVERAGE_KEY } });
  if (!row || row.payload === null) return new Set();
  const c = fromJson<StoredCoverage>(row.payload);
  if (appSlug && c.appSlug !== appSlug) return new Set();
  return new Set(Array.isArray(c.covered) ? c.covered.filter((x): x is string => typeof x === "string") : []);
}
