import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { ensureRecurring, reclaimStuck, runOne, type Handler } from "@/lib/jobs";
import { checkProfile } from "@/lib/local/identity";
import { pollMode } from "@/lib/local/activity";
import { RECONCILE_EVERY_MS, handlers } from "@/lib/local/handlers";
import { getEngine, notifyChange } from "@/lib/local/runtime";
import { recoverDiscovery, shutdownDiscovery, tickDiscovery } from "@/lib/local/discovery-jobs";

/**
 * In-process background work for the LOCAL app. It runs while this process runs, and only then: nothing here pretends a
 * scheduler keeps executing when every client is closed. Shared state itself persists in GitHub meanwhile.
 *
 * Two independent lanes with separate rate-limit budgets:
 *   1. coordination spaces (SyncEngine.tick: head checks, pushes of the outbox)
 *   2. source repositories (job queue: issues, PRs, comments, branches, fork comparisons)
 */

type G = typeof globalThis & { __mpScheduler?: { timer: ReturnType<typeof setInterval>; busy: boolean; lastTick: number } };
const g = globalThis as G;

/** Runs up to `max` due jobs. Each finished job tells the open pages, so refresh progress, results and failures show without a reload. */
export async function drainJobs(run: Record<string, Handler> = handlers, notify: (reason: "state") => void = notifyChange, max = 5): Promise<number> {
  let n = 0;
  for (let i = 0; i < max; i++) {
    const r = await runOne(db, run);
    if (r === "idle") break;
    n++;
    notify("state");
  }
  return n;
}

export async function tickOnce(now = Date.now()): Promise<{ coordination: number; jobs: number }> {
  const out = { coordination: 0, jobs: 0 };
  if (isDemo()) return out;
  const profile = await checkProfile();
  // Every call is bound to this profile's own account (bound.ts), so another account being selected in gh does not stop sync and
  // cannot be used by it. With no profile there is nothing to sync.
  if (profile.kind === "no-profile") return out;
  const idle = pollMode(now) === "idle";
  const engine = await getEngine();
  if (engine && (!idle || now - (g.__mpScheduler?.lastTick ?? 0) >= 60_000)) {
    out.coordination = (await engine.tick()).polled;
    if (g.__mpScheduler) g.__mpScheduler.lastTick = now;
  }
  await tickDiscovery(); // retries of cached GitHub lists that are due; bounded, deduplicated, never awaited on a page
  await ensureRecurring(db, { type: "reconcile.all", key: "reconcile", intervalMs: RECONCILE_EVERY_MS });
  await reclaimStuck(db);
  out.jobs = await drainJobs();
  return out;
}

/**
 * Runs the due jobs now instead of at the next 5 s tick (a webhook-triggered refresh should not wait for it). It uses the
 * scheduler's own `busy` flag, so it never runs beside a tick: if one is running, that tick's drain (or the next tick) picks
 * the job up. A no-op when the scheduler was not started in this process.
 */
export async function runJobsNow(): Promise<void> {
  const s = g.__mpScheduler;
  if (!s || s.busy || isDemo()) return;
  s.busy = true;
  try {
    await drainJobs();
  } catch (e) {
    console.error("job run failed", e instanceof Error ? e.message : e);
  } finally {
    s.busy = false;
  }
}

export function startLocalScheduler(intervalMs = 5000) {
  if (g.__mpScheduler) return;
  void recoverDiscovery().catch(() => {}); // an attempt a crash interrupted must not stay "retrying" for ever
  // Shutdown: cancel background refreshes and kill any gh process still running, so none outlives the app.
  process.once("exit", shutdownDiscovery);
  process.once("SIGTERM", shutdownDiscovery);
  process.once("SIGINT", shutdownDiscovery);
  const state = { busy: false, lastTick: 0, timer: undefined as unknown as ReturnType<typeof setInterval> };
  state.timer = setInterval(async () => {
    if (state.busy) return;
    state.busy = true;
    try {
      await tickOnce();
    } catch (e) {
      console.error("scheduler tick failed", e instanceof Error ? e.message : e);
    } finally {
      state.busy = false;
    }
  }, intervalMs);
  state.timer.unref?.();
  g.__mpScheduler = state;
}
