export type LimitResult = { ok: true } | { ok: false; retryAfterSec: number };
export type Limiter = {
  take(key: string, limit: number, windowMs: number): LimitResult;
  /** Number of keys currently tracked. */
  size(): number;
};

const SWEEP_EVERY_MS = 10_000;

/** In-memory sliding-window limiter. Keys with no hits inside their window are swept, so memory stays bounded. */
export function createLimiter(now: () => number): Limiter {
  const buckets = new Map<string, { hits: number[]; windowMs: number }>();
  let lastSweep = now();

  function sweep(t: number): void {
    lastSweep = t;
    for (const [k, b] of buckets) if (b.hits.length === 0 || b.hits[b.hits.length - 1] <= t - b.windowMs) buckets.delete(k);
  }

  return {
    take(key, limit, windowMs) {
      const t = now();
      if (t - lastSweep >= SWEEP_EVERY_MS || t < lastSweep) sweep(t);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { hits: [], windowMs }));
      b.windowMs = windowMs;
      while (b.hits.length > 0 && b.hits[0] <= t - windowMs) b.hits.shift();
      if (b.hits.length >= limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.hits[0] + windowMs - t) / 1000)) };
      b.hits.push(t);
      return { ok: true };
    },
    size: () => buckets.size,
  };
}
