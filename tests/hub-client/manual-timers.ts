import type { Timers } from "@/lib/hub/link";

/** Deterministic timers: nothing fires until `advance` moves the clock. */
export class ManualTimers implements Timers {
  now = 0;
  private nextId = 1;
  private items = new Map<number, { at: number; fn: () => void; every?: number }>();
  /** Delays of every setTimeout / setInterval call, in call order. */
  scheduled: number[] = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.scheduled.push(ms);
    this.items.set(id, { at: this.now + ms, fn });
    return id;
  };
  setInterval = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.scheduled.push(ms);
    this.items.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  };
  clearTimeout = (h: unknown): void => void this.items.delete(h as number);
  clearInterval = (h: unknown): void => void this.items.delete(h as number);
  get pending() {
    return this.items.size;
  }
  advance(ms: number) {
    const target = this.now + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of this.items) if (e[1].at <= target && (!best || e[1].at < best[1].at)) best = e;
      if (!best) break;
      const [id, it] = best;
      this.now = it.at;
      if (it.every) it.at += it.every;
      else this.items.delete(id);
      it.fn();
    }
    this.now = target;
  }
}
