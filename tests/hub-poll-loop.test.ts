import { describe, expect, it, vi } from "vitest";
import { runPollLoop } from "@/lib/hub/poll-loop";

describe("runPollLoop", () => {
  it("stops when onResult says so", async () => {
    let n = 0;
    const seen: number[] = [];
    await runPollLoop({ poll: async () => ++n, intervalMs: 1, signal: new AbortController().signal, onResult: (r) => (seen.push(r), r === 3) });
    expect(seen).toEqual([1, 2, 3]);
  });
  it("cancel during an in-flight poll drops the late ok and schedules nothing more", async () => {
    const ac = new AbortController();
    let release!: (v: string) => void;
    let calls = 0;
    const seen: string[] = [];
    const done = runPollLoop({
      poll: () => (++calls, new Promise<string>((r) => (release = r))),
      intervalMs: 1,
      signal: ac.signal,
      onResult: (r) => (seen.push(r), false),
    });
    while (calls === 0) await new Promise((r) => setTimeout(r, 2));
    ac.abort();
    release("ok");
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([]);
    expect(calls).toBe(1);
  });
  it("cancel while waiting never polls", async () => {
    const ac = new AbortController();
    let calls = 0;
    const done = runPollLoop({ poll: async () => ++calls, intervalMs: 10_000, signal: ac.signal, onResult: () => false });
    ac.abort();
    await done;
    expect(calls).toBe(0);
  });
  it("keeps going after a transient failure", async () => {
    let n = 0;
    const seen: number[] = [];
    await runPollLoop({ poll: async () => { if (++n === 1) throw new Error("net"); return n; }, intervalMs: 1, signal: new AbortController().signal, onResult: (r) => (seen.push(r), true) });
    expect(seen).toEqual([2]);
  });


  it("reads a function interval before every wait, so a slow-down lengthens the next poll", async () => {
    const waits: number[] = [];
    let interval = 1;
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => (waits.push(ms ?? 0), orig(fn, 0))) as typeof setTimeout);
    try {
      let n = 0;
      await runPollLoop({ poll: async () => ++n, intervalMs: () => interval, signal: new AbortController().signal, onResult: (r) => (r === 1 && (interval += 5000), r === 3) });
    } finally {
      spy.mockRestore();
    }
    expect(waits).toEqual([1, 5001, 5001]);
  });
});
