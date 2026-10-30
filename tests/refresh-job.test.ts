import { beforeEach, describe, expect, it, vi } from "vitest";
import { truncateAll } from "@/lib/demo/seed";
import { FakeGithub } from "@/lib/github/fake";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";
import { refreshRepositoryAndWait } from "@/lib/services/refresh";
import { testDb } from "./helpers";

const mocks = vi.hoisted(() => ({ notifyChange: vi.fn(), port: null as unknown }));
vi.mock("@/lib/local/runtime", () => ({ notifyChange: mocks.notifyChange }));
vi.mock("@/lib/github/factory", () => ({ portForSync: async () => mocks.port }));

const db = testDb();
const META: RepoMeta = { githubId: 5n, fullName: "acme/tool", name: "tool", htmlUrl: "https://github.com/acme/tool", visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: 1005n, login: "acme", type: "ORGANIZATION" } };

let repoId: string;
beforeEach(async () => {
  await truncateAll(db);
  mocks.notifyChange.mockClear();
  const ws = await db.workspace.create({ data: { name: "ws" } });
  repoId = (await upsertRepository(db, ws.id, META)).id;
});

const status = async () => (await db.job.findFirstOrThrow({ where: { dedupeKey: `sync:${repoId}` } })).status;
const instant = async () => {};

describe("refreshRepositoryAndWait", () => {
  it("queues the Refresh job, asks for it to run, and resolves only when the job is DONE", async () => {
    let polls = 0;
    let kicks = 0;
    const r = await refreshRepositoryAndWait(db, repoId, {
      kick: () => void kicks++,
      sleep: async () => {
        if (++polls === 3) await db.job.updateMany({ where: { dedupeKey: `sync:${repoId}` }, data: { status: "DONE" } });
      },
    });
    expect(r).toBe("done");
    expect(polls).toBe(3);
    expect(kicks).toBeGreaterThanOrEqual(3); // once after queueing, again while it stays QUEUED
    const job = await db.job.findFirstOrThrow({ where: { dedupeKey: `sync:${repoId}` } });
    expect(job.payload).toEqual({ repositoryId: repoId, full: true });
  });

  it("resolves when the job FAILED", async () => {
    const r = await refreshRepositoryAndWait(db, repoId, { sleep: () => db.job.updateMany({ where: { dedupeKey: `sync:${repoId}` }, data: { status: "FAILED" } }).then(() => {}) });
    expect(r).toBe("failed");
  });

  it("keeps waiting while the job is RUNNING and gives up after the timeout, so the caller is released", async () => {
    await db.job.deleteMany();
    let polls = 0;
    const r = await refreshRepositoryAndWait(db, repoId, {
      pollMs: 250,
      timeoutMs: 120_000,
      sleep: async () => {
        if (polls++ === 0) await db.job.updateMany({ where: { dedupeKey: `sync:${repoId}` }, data: { status: "RUNNING" } });
      },
    });
    expect(r).toBe("timeout");
    expect(polls).toBe(480); // 2 minutes of 250 ms polls
    expect(await status()).toBe("RUNNING");
  });

  it("a job that is requeued (dirty) is not reported done early", async () => {
    let polls = 0;
    const r = await refreshRepositoryAndWait(db, repoId, {
      timeoutMs: 1000,
      pollMs: 250,
      sleep: async () => {
        if (polls++ === 0) await db.job.updateMany({ where: { dedupeKey: `sync:${repoId}` }, data: { status: "DONE", dirty: true } });
      },
    });
    expect(r).toBe("timeout");
  });

  it("is the same job the Refresh button queues (one job per repository)", async () => {
    await refreshRepositoryAndWait(db, repoId, { sleep: instant, timeoutMs: 250 });
    await refreshRepositoryAndWait(db, repoId, { sleep: instant, timeoutMs: 250 });
    expect(await db.job.count({ where: { type: "sync.repository" } })).toBe(1);
  });
});

describe("the sync.repository job", () => {
  it("tells the open pages the data changed when it finishes successfully, and not when it fails", async () => {
    const { handlers } = await import("@/lib/local/handlers");
    const fake = new FakeGithub();
    fake.repos.set("acme/tool", META);
    fake.branches.set("acme/tool", [{ name: "main", sha: "m1", isDefault: true }]);
    mocks.port = fake;
    await handlers["sync.repository"]({ repositoryId: repoId, full: true } as never, {} as never);
    expect(mocks.notifyChange).toHaveBeenCalledWith("pulled");
    mocks.notifyChange.mockClear();
    fake.repos.clear(); // GitHub no longer finds the repository
    await expect(handlers["sync.repository"]({ repositoryId: repoId, full: true } as never, {} as never)).rejects.toThrow();
    expect(mocks.notifyChange).not.toHaveBeenCalled();
  });
});

describe("runJobsNow", () => {
  it("does nothing without a scheduler in this process and never runs beside a busy tick", async () => {
    const { runJobsNow } = await import("@/lib/local/scheduler");
    const g = globalThis as { __mpScheduler?: { busy: boolean; timer: unknown; lastTick: number } };
    const before = g.__mpScheduler;
    g.__mpScheduler = undefined;
    await expect(runJobsNow()).resolves.toBeUndefined();
    g.__mpScheduler = { busy: true, timer: null, lastTick: 0 };
    await refreshRepositoryAndWait(db, repoId, { sleep: instant, timeoutMs: 250 });
    await runJobsNow();
    expect(await status()).toBe("QUEUED"); // not run: a tick holds the worker
    expect(g.__mpScheduler.busy).toBe(true);
    g.__mpScheduler = before;
  });
});
