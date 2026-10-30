import type { Db } from "@/lib/db";
import { enqueue } from "@/lib/jobs";

/**
 * The service call behind the Repositories page's Refresh button: queue a complete refresh of one repository. A person asking
 * for a refresh gets a complete one: every page is listed again (unchanged items cost no detail requests), so a repository
 * whose earlier sync was cut short is repaired instead of only receiving what changed since. Requests for one repository merge
 * into one job (`dedupeKey`). The scheduler runs it with the person's own gh, through the same job as the button.
 */
export function requestRepositoryRefresh(db: Db, repositoryId: string) {
  return enqueue(db, { type: "sync.repository", payload: { repositoryId, full: true }, dedupeKey: `sync:${repositoryId}` });
}

export const REFRESH_POLL_MS = 250;
export const REFRESH_TIMEOUT_MS = 120_000;

/**
 * Queues the refresh, asks for due jobs to run now (`kick`), and resolves when the job has really finished (DONE or FAILED), or
 * after `timeoutMs` so a stuck job cannot hold the caller for ever. A job that is retried later (QUEUED again after a failure)
 * keeps the caller waiting until the timeout.
 */
export async function refreshRepositoryAndWait(
  db: Db,
  repositoryId: string,
  o: { kick?: () => void; sleep?: (ms: number) => Promise<void>; pollMs?: number; timeoutMs?: number } = {},
): Promise<"done" | "failed" | "timeout"> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? REFRESH_POLL_MS;
  const budget = o.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const job = await requestRepositoryRefresh(db, repositoryId);
  o.kick?.();
  for (let waited = 0; waited < budget; waited += pollMs) {
    await sleep(pollMs);
    const row = await db.job.findUnique({ where: { id: job.id }, select: { status: true, dirty: true } });
    if (!row) return "failed";
    if (row.status === "DONE" && !row.dirty) return "done";
    if (row.status === "FAILED") return "failed";
    if (row.status === "QUEUED") o.kick?.(); // the scheduler's own tick may have been busy when we first asked
  }
  return "timeout";
}
