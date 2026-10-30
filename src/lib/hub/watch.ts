import type { Db } from "@/lib/db";

/**
 * The set of GitHub repositories this profile wants instant updates for: every ACTIVE tracked repository, as decimal
 * ids. The hub keeps it per connection; `refreshHubWatch()` is how the services say "the tracked set changed".
 */
export async function trackedGithubIds(db: Db): Promise<string[]> {
  const rows = await db.repository.findMany({ where: { trackingStatus: "ACTIVE", isDemo: false }, select: { githubId: true } });
  return [...new Set(rows.map((r) => r.githubId.toString()))].sort();
}

type G = typeof globalThis & { __mpHubWatch?: (() => void) | null };
const g = globalThis as G;

/** Registered by the running hub live link (one per process); null when there is none. */
export function registerHubWatch(fn: (() => void) | null) {
  g.__mpHubWatch = fn;
}

/**
 * Re-sends the watched set to the hub after tracking, untracking or a status change. A no-op without a hub link; never throws.
 * Same process: the job worker is the scheduler `src/instrumentation.ts` starts (`startLocalScheduler`), which runs in the Node
 * process that also holds the live link and the services calling this, so one in-process registry is enough.
 */
export function refreshHubWatch(): void {
  try {
    g.__mpHubWatch?.();
  } catch {
    // the next hello or the live poll sends the set again
  }
}
