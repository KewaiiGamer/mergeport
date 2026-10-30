import { db } from "@/lib/db";
import { canSpend } from "@/lib/domain/sync";
import { portForSync } from "@/lib/github/factory";
import { GithubError } from "@/lib/github/port";
import type { Handler } from "@/lib/jobs";
import { setStatus, syncFork, syncItem, syncRepository } from "@/lib/sync/repository";

/**
 * Jobs for SOURCE repositories (issues, PRs, comments, reviews, branches), fetched with the signed-in person's own
 * access. Their rate-limit budget ("source") is tracked separately from coordination-space sync, so a burst of source
 * refreshes can never starve shared-state sync, and vice versa.
 */

export const SOURCE_BUDGET_KEY = "source";
export const RECONCILE_EVERY_MS = 15 * 60_000;

export async function guardSourceBudget() {
  const rl = await db.rateLimitState.findUnique({ where: { key: SOURCE_BUDGET_KEY } });
  const state = rl ? { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt } : null;
  if (!canSpend(state, 10, 25)) {
    const secs = Math.max(30, Math.ceil((state!.resetAt.getTime() - Date.now()) / 1000));
    throw new GithubError("rate-limited", "Waiting for the GitHub API budget to reset", secs, state!.resetAt);
  }
}

async function recordRate(rate: { remaining: number; limit: number; resetAt: Date } | null) {
  if (!rate) return;
  await db.rateLimitState.upsert({ where: { key: SOURCE_BUDGET_KEY }, create: { key: SOURCE_BUDGET_KEY, ...rate }, update: { ...rate } });
}

export const handlers: Record<string, Handler> = {
  "sync.repository": (async (p: { repositoryId: string; full?: boolean }) => {
    await guardSourceBudget();
    const port = await portForSync(db, p.repositoryId);
    if (!port) return;
    try {
      await syncRepository(db, port, p.repositoryId, { full: p.full });
    } finally {
      await recordRate(port.lastRate());
    }
    // The data of this repository changed: redraw the open pages (also right for the Refresh button).
    (await import("@/lib/local/runtime")).notifyChange("pulled");
    const maps = await db.forkMapping.findMany({ where: { OR: [{ forkRepoId: p.repositoryId }, { upstreamRepoId: p.repositoryId }] }, select: { id: true } });
    const { enqueue } = await import("@/lib/jobs");
    for (const m of maps) await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
  }) as Handler,
  "sync.item": (async (p: { repositoryId: string; number: number }) => {
    await guardSourceBudget();
    const port = await portForSync(db, p.repositoryId);
    if (port) await syncItem(db, port, p.repositoryId, p.number);
  }) as Handler,
  "sync.fork": (async (p: { mappingId: string }) => {
    const m = await db.forkMapping.findUnique({ where: { id: p.mappingId } });
    if (!m) return;
    await guardSourceBudget();
    const port = await portForSync(db, m.forkRepoId);
    if (port) await syncFork(db, port, p.mappingId);
  }) as Handler,
  // Recurrence is owned by the runner (ensureRecurring), never by this handler.
  "reconcile.all": (async () => {
    const { enqueue } = await import("@/lib/jobs");
    const repos = await db.repository.findMany({ where: { trackingStatus: { in: ["ACTIVE", "DISCONNECTED"] }, isDemo: false }, select: { id: true } });
    for (const r of repos) await enqueue(db, { type: "sync.repository", payload: { repositoryId: r.id }, dedupeKey: `sync:${r.id}` });
  }) as Handler,
};

export { setStatus };
