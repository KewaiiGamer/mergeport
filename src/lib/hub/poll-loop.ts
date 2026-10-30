/**
 * Polls until `onResult` returns true or `signal` aborts. After an abort nothing more is scheduled, and a reply that was
 * still in flight is dropped without reaching `onResult`. `intervalMs` is read before every wait, so a function can
 * lengthen it (a server that asked to slow down).
 */
export async function runPollLoop<R>(o: { poll: (signal: AbortSignal) => Promise<R>; intervalMs: number | (() => number); signal: AbortSignal; onResult: (r: R) => boolean }): Promise<void> {
  const { signal } = o;
  const wait = () =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, typeof o.intervalMs === "function" ? o.intervalMs() : o.intervalMs);
      signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  while (!signal.aborted) {
    await wait();
    if (signal.aborted) return;
    let r: R;
    try {
      r = await o.poll(signal);
    } catch {
      continue; // transient failure: try again at the next interval
    }
    if (signal.aborted) return;
    if (o.onResult(r)) return;
  }
}
