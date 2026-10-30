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
