import type { Db } from "@/lib/db";
import type { SyncEngine } from "@/lib/sync/engine";
import type { HubClient } from "./types";
import { HubLink, defaultTimers, type HubLinkState, type SocketLike, type Timers } from "./link";
import { syncHubSpaces } from "./spaces";
import { handleGithubEvent } from "./gh-events";
import { RepoRefresher } from "./repo-refresher";
import { registerHubWatch, trackedGithubIds } from "./watch";
import { requestRepositoryRefresh } from "@/lib/services/refresh";

const FALLBACK_POLL_MS = 60_000;
/** engine.syncSpace silently returns when a cycle is already running; a notified seq not reached is retried this often, a few times. */
const RETRY_MS = 150;
const MAX_RETRIES = 5;

export type HubLiveOptions = {
  db: Db;
  engine: SyncEngine;
  client: HubClient;
  origin: string;
  getToken: () => Promise<string | null>;
  connect?: (url: string, protocols: string[]) => SocketLike;
  timers?: Timers;
  random?: () => number;
  /** Called after GitHub events changed local data (the runtime emits `notifyChange("pulled")`). */
  notify?: () => void;
  /** The fallback refresh of one repository (default: the Repositories page's Refresh, queued as a job). */
  refreshRepository?: (repositoryId: string) => Promise<void>;
  /** Clock for the fallback refresher (tests). */
  now?: () => number;
};

/**
 * Wires a HubLink to the engine. Hub spaces are driven by the socket while it is live; otherwise a 60 s poll
 * keeps them fresh. The engine's `hubLive` dep must read `live()` so its own tick() leaves hub spaces alone.
 */
export function startHubLive(o: HubLiveOptions): { link: HubLink; live(): boolean; stop(): void; refreshWatch(): Promise<void> } {
  const timers = o.timers ?? defaultTimers;
  let stopped = false;
  let poll: unknown = null;

  // One cycle per space at a time; a notification that arrives mid-cycle schedules exactly one more.
  const inflight = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const wanted = new Map<string, bigint>(); // highest seq announced per local space id
  const waiting = new Set<unknown>();
  const syncOne = (spaceId: string): Promise<void> => {
    const running = inflight.get(spaceId);
    if (running) {
      dirty.add(spaceId);
      return running;
    }
    const p = (async () => {
      try {
        let retries = 0;
        for (;;) {
          dirty.delete(spaceId);
          const sp = await o.db.space.findUnique({ where: { id: spaceId } });
          if (!sp || sp.backend !== "HUB" || sp.access === "REVOKED") return;
          await o.engine.syncSpace(sp);
          if (dirty.has(spaceId)) continue;
          const after = await o.db.space.findUnique({ where: { id: spaceId } });
          const want = wanted.get(spaceId);
          if (stopped || !after || after.access === "REVOKED" || want === undefined || after.hubCursor >= want || retries++ >= MAX_RETRIES) return;
          await new Promise<void>((resolve) => {
            const h = timers.setTimeout(() => {
              waiting.delete(h);
              resolve();
            }, RETRY_MS);
            waiting.add(h);
          });
          if (stopped) return;
        }
      } catch {
        // recorded on the space by the engine; the fallback poll retries
      } finally {
        inflight.delete(spaceId);
      }
    })();
    inflight.set(spaceId, p);
    return p;
  };
  const syncAll = async () => {
    const spaces = await o.db.space.findMany({ where: { backend: "HUB" } });
    await Promise.all(spaces.map((s) => syncOne(s.id)));
  };

  // me() + syncHubSpaces, serialised so two notifications never race to create the same Space row.
  let queue: Promise<void> = Promise.resolve();
  const refresh = (): Promise<void> => {
    const run = async () => {
      try {
        await syncHubSpaces(o.db, o.engine, await o.client.me(), o.origin);
      } catch {
        // a failing me() must not stop the spaces from syncing; the cycle records the failure
      }
    };
    return (queue = queue.then(run, run));
  };
  const refreshAndSyncAll = async () => {
    await refresh();
    await syncAll();
  };

  const byHubId = (hubSpaceId: string) => o.db.space.findFirst({ where: { backend: "HUB", hubSpaceId } });
  const revoke = async (hubSpaceId: string) => {
    const sp = await byHubId(hubSpaceId);
    if (sp && sp.access !== "REVOKED") await o.engine.revokeSpace(sp.id, "You no longer have access to this space");
  };
  const revokeAll = async () => {
    for (const s of await o.db.space.findMany({ where: { backend: "HUB" } })) {
      if (s.access !== "REVOKED") await o.engine.revokeSpace(s.id, "You were removed from this server");
    }
  };

  // Instant GitHub updates: the tracked set goes to the hub after every hello and whenever it changes.
  let lastWatch: string | null = null;
  let watchTicket = 0;
  const sendWatch = async (): Promise<void> => {
    if (stopped || !link.isOpen) return;
    const ticket = ++watchTicket;
    const ids = await trackedGithubIds(o.db);
    if (stopped || ticket !== watchTicket || !link.isOpen) return;
    const key = ids.join(",");
    if (key === lastWatch) return;
    lastWatch = key;
    link.watch(ids);
  };
  const notify = () => o.notify?.();
  const refresher = new RepoRefresher({
    run: (id) => (o.refreshRepository ? o.refreshRepository(id) : requestRepositoryRefresh(o.db, id).then(() => undefined)),
    onDone: notify,
    timers: o.timers,
    now: o.now,
  });

  const link: HubLink = new HubLink({
    origin: o.origin,
    getToken: o.getToken,
    connect: o.connect,
    timers: o.timers,
    random: o.random,
    onHello: () => {
      lastWatch = null; // a new connection has an empty watched set
      void sendWatch().catch(() => {});
      void refreshAndSyncAll().catch(() => {});
    },
    onGithubEvent: (e) => void handleGithubEvent(o.db, e, { refresh: (id) => refresher.request(id), notify }).catch(() => {}),
    onChanged: (hubSpaceId, seq) => {
      void (async () => {
        let sp = await byHubId(hubSpaceId);
        if (!sp) {
          await refresh();
          sp = await byHubId(hubSpaceId);
        }
        if (!sp || sp.access === "REVOKED" || sp.hubCursor >= seq) return;
        if (seq > (wanted.get(sp.id) ?? 0n)) wanted.set(sp.id, seq);
        await syncOne(sp.id);
      })().catch(() => {});
    },
    onAccess: (hubSpaceId, action) => {
      void (async () => {
        if (action === "added") {
          await refresh();
          const sp = await byHubId(hubSpaceId);
          if (sp) await syncOne(sp.id);
        } else await revoke(hubSpaceId);
      })().catch(() => {});
    },
    onTeam: () => void refresh().catch(() => {}),
    onState: (s: HubLinkState) => {
      if (s === "removed") void revokeAll().catch(() => {});
    },
  });

  // Always on. Not live: refresh and sync every hub space. Live: only spaces that look unhealthy, so a
  // failed cycle, an exhausted retry or a 5xx / 429 never leaves a live space stale until the next hello.
  const pollOnce = async () => {
    if (link.state === "removed") return;
    if (link.state !== "live") return refreshAndSyncAll();
    void sendWatch().catch(() => {}); // safety net for a tracking change that did not announce itself
    const now = new Date();
    for (const s of await o.db.space.findMany({ where: { backend: "HUB", access: { not: "REVOKED" } } })) {
      const want = wanted.get(s.id);
      const unhealthy = !!s.lastError || (!!s.rateLimitedUntil && s.rateLimitedUntil <= now) || (want !== undefined && s.hubCursor < want);
      if (unhealthy) void syncOne(s.id);
    }
  };
  const startPoll = () => {
    poll = timers.setInterval(() => {
      if (!stopped) void pollOnce().catch(() => {});
    }, FALLBACK_POLL_MS);
  };
  const stopPoll = () => {
    if (poll !== null) timers.clearInterval(poll);
    poll = null;
  };

  startPoll();
  registerHubWatch(() => void sendWatch().catch(() => {}));
  // An op left SENT by a crash mid-push is safe to resend: the hub answers `duplicate`.
  void (async () => {
    try {
      const ids = (await o.db.space.findMany({ where: { backend: "HUB" }, select: { id: true } })).map((x) => x.id);
      await o.db.outboxOp.updateMany({ where: { spaceId: { in: ids }, status: "SENT" }, data: { status: "PENDING" } });
    } catch {
      // the next push settles it
    }
    if (!stopped) link.start();
  })();
  return {
    link,
    live: () => link.state === "live",
    stop: () => {
      stopped = true;
      for (const h of waiting) timers.clearTimeout(h);
      waiting.clear();
      stopPoll();
      refresher.stop();
      registerHubWatch(null);
      link.stop();
    },
    refreshWatch: sendWatch,
  };
}
