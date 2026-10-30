import { defaultTimers, type Timers } from "./link";

/**
 * Fallback for GitHub events whose effect cannot be applied from the payload: refresh the whole repository the way the
 * Repositories page's Refresh button does. A burst of events for one repository is coalesced into one refresh
 * (`coalesceMs`), refreshes of one repository never overlap, and two refreshes start at least `minGapMs` apart (`bulkGapMs`
 * when a "bulk" event such as a check run or a push asked for it: those arrive in floods and cost a full read): a request
 * inside that window is delayed to its end, never dropped. `run` must resolve when the refresh really finished.
 */
export type RepoRefresherOptions = {
  /** Does one refresh. Rejections are swallowed: the 15 minute cycle is the safety net. */
  run(repositoryId: string): Promise<void>;
  /** Called after each finished refresh, successful or not. */
  onDone?(repositoryId: string): void;
  timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
  now?: () => number;
  coalesceMs?: number;
  minGapMs?: number;
  bulkGapMs?: number;
};

export const COALESCE_MS = 1500;
export const MIN_GAP_MS = 5000;
export const BULK_GAP_MS = 30_000;

type Entry = { timer: unknown; running: boolean; again: boolean; bulk: boolean; lastStart: number | undefined };

export class RepoRefresher {
  private readonly entries = new Map<string, Entry>();
  private readonly timers: Pick<Timers, "setTimeout" | "clearTimeout">;
  private readonly now: () => number;
  private readonly coalesceMs: number;
  private readonly minGapMs: number;
  private readonly bulkGapMs: number;
  private stopped = false;

  constructor(private readonly o: RepoRefresherOptions) {
    this.timers = o.timers ?? defaultTimers;
    this.now = o.now ?? Date.now;
    this.coalesceMs = o.coalesceMs ?? COALESCE_MS;
    this.minGapMs = o.minGapMs ?? MIN_GAP_MS;
    this.bulkGapMs = o.bulkGapMs ?? BULK_GAP_MS;
  }

  request(repositoryId: string, kind: "item" | "bulk" = "item"): void {
    if (this.stopped) return;
    let e = this.entries.get(repositoryId);
    if (!e) this.entries.set(repositoryId, (e = { timer: null, running: false, again: false, bulk: false, lastStart: undefined }));
    const widen = kind === "bulk" && !e.bulk;
    if (kind === "bulk") e.bulk = true;
    if (e.timer !== null) {
      // already scheduled: this event joins that refresh (a bulk one may push its start later)
      if (widen) {
        this.timers.clearTimeout(e.timer);
        this.schedule(repositoryId, e);
      }
      return;
    }
    if (e.running) {
      e.again = true; // scheduled when the running one ends
      return;
    }
    this.schedule(repositoryId, e);
  }

  stop(): void {
    this.stopped = true;
    for (const e of this.entries.values()) if (e.timer !== null) this.timers.clearTimeout(e.timer);
    this.entries.clear();
  }

  private schedule(id: string, e: Entry) {
    const wait = e.lastStart === undefined ? 0 : e.lastStart + (e.bulk ? this.bulkGapMs : this.minGapMs) - this.now();
    e.timer = this.timers.setTimeout(() => void this.fire(id, e), Math.max(this.coalesceMs, wait));
  }

  private async fire(id: string, e: Entry) {
    e.timer = null;
    if (this.stopped) return;
    e.bulk = false;
    e.running = true;
    e.lastStart = this.now();
    try {
      await this.o.run(id);
    } catch {
      // the next event or the 15 minute cycle covers it
    }
    e.running = false;
    try {
      this.o.onDone?.(id);
    } catch {
      // never blocks later refreshes
    }
    if (e.again && !this.stopped) {
      e.again = false;
      this.schedule(id, e);
    }
  }
}
