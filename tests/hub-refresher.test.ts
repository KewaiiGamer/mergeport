import { describe, expect, it } from "vitest";
import { RepoRefresher } from "@/lib/hub/repo-refresher";
import { ManualTimers } from "./hub-client/manual-timers";

const flush = () => new Promise<void>((r) => setImmediate(r));

function setup(run?: (id: string) => Promise<void>) {
  const timers = new ManualTimers();
  const started: [string, number][] = [];
  const done: string[] = [];
  const r = new RepoRefresher({
    run:
      run ??
      ((id) => {
        started.push([id, timers.now]);
        return Promise.resolve();
      }),
    onDone: (id) => done.push(id),
    timers,
    now: () => timers.now,
  });
  return { timers, started, done, r };
}

describe("repository refresher (fallback for events that are not applied from the payload)", () => {
  it("merges a burst for one repository into one refresh after 1500 ms", async () => {
    const t = setup();
    for (let i = 0; i < 20; i++) {
      t.r.request("r1");
      t.timers.advance(50);
    }
    expect(t.started).toEqual([]);
    t.timers.advance(1500);
    await flush();
    expect(t.started).toEqual([["r1", 1500]]); // the window opened at the first request, later ones joined it
    t.timers.advance(10_000);
    await flush();
    expect(t.started).toHaveLength(1);
    expect(t.done).toEqual(["r1"]);
  });

  it("repositories are independent", async () => {
    const t = setup();
    t.r.request("a");
    t.r.request("b");
    t.timers.advance(1500);
    await flush();
    expect(t.started.map((s) => s[0]).sort()).toEqual(["a", "b"]);
  });

  it("never overlaps for one repository: a request during a refresh runs after it, not beside it", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: (() => void)[] = [];
    const t = setup(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>((res) =>
        releases.push(() => {
          active--;
          res();
        }),
      );
    });
    t.r.request("r1");
    t.timers.advance(1500);
    await flush();
    expect(releases).toHaveLength(1);
    t.r.request("r1"); // arrives while the first one runs
    t.r.request("r1");
    t.timers.advance(20_000);
    await flush();
    expect(releases).toHaveLength(1); // still waiting for the running one
    releases[0]();
    await flush();
    t.timers.advance(5_000);
    await flush();
    expect(releases).toHaveLength(2);
    releases[1]();
    await flush();
    t.timers.advance(60_000);
    await flush();
    expect(releases).toHaveLength(2); // the two requests during the run became one
    expect(maxActive).toBe(1);
  });

  it("delays a second refresh inside 5 s to the end of the window, never drops it", async () => {
    const t = setup();
    t.r.request("r1");
    t.timers.advance(1500); // first refresh starts at 1500
    await flush();
    t.timers.advance(500);
    t.r.request("r1"); // at 2000, 500 ms after the start
    t.timers.advance(4_499); // 6499: not yet
    await flush();
    expect(t.started).toHaveLength(1);
    t.timers.advance(1); // 6500 = 1500 + 5000
    await flush();
    expect(t.started.map((s) => s[1])).toEqual([1500, 6500]);
  });

  it("a request after the window waits only the 1500 ms burst delay", async () => {
    const t = setup();
    t.r.request("r1");
    t.timers.advance(1500);
    await flush();
    t.timers.advance(10_000); // 11500
    t.r.request("r1");
    t.timers.advance(1499);
    await flush();
    expect(t.started).toHaveLength(1);
    t.timers.advance(1);
    await flush();
    expect(t.started.map((s) => s[1])).toEqual([1500, 13000]);
  });

  it("a failing refresh does not stop later ones and does not throw", async () => {
    let n = 0;
    const t = setup(async () => {
      if (n++ === 0) throw new Error("gh failed");
    });
    t.r.request("r1");
    t.timers.advance(1500);
    await flush();
    t.r.request("r1");
    t.timers.advance(5000);
    await flush();
    expect(n).toBe(2);
    expect(t.done).toEqual(["r1", "r1"]);
  });

  it("stop clears pending timers and ignores later requests", async () => {
    const t = setup();
    t.r.request("r1");
    t.r.stop();
    expect(t.timers.pending).toBe(0);
    t.r.request("r1");
    t.timers.advance(10_000);
    await flush();
    expect(t.started).toEqual([]);
  });
});
