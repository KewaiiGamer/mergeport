import { spawn } from "node:child_process";
import path from "node:path";
import { killTree } from "@/lib/github/exec";
import type { ChildHandle, ChildSpec } from "@/lib/local/supervisor";

const KILL_TIMEOUT_MS = 15_000;

/** Runs `next start` for one profile. kill() resolves only after the process has exited, so the port is free again. */
export function spawnNext(spec: ChildSpec, extraEnv: Record<string, string>): ChildHandle {
  const next = path.join("node_modules", "next", "dist", "bin", "next");
  const env = { ...process.env, MERGEPORT_DB: spec.dbFile, MERGEPORT_LAUNCH_TOKEN: spec.token, MERGEPORT_PORT: String(spec.port), MERGEPORT_BACKEND: spec.backend ?? "github", DEMO_MODE: spec.demo ? "true" : "false", NODE_ENV: "production", ...extraEnv } as unknown as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, [next, "start", "-H", "127.0.0.1", "-p", String(spec.port)], { stdio: "inherit", env });
  let exited = false;
  const waiters: Array<() => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  const done = (code: number | null) => {
    if (exited) return;
    exited = true;
    waiters.splice(0).forEach((w) => w());
    exitCbs.forEach((cb) => cb(code));
  };
  child.once("exit", (code) => done(code));
  // A process that could not even start never emits "exit": treat it as exited so boot fails fast and kill() resolves.
  child.once("error", () => done(1));
  return {
    kill() {
      if (exited) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The app process did not stop")), KILL_TIMEOUT_MS);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        killTree(child);
      });
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
  };
}

/** Polls /api/local/ready every 200 ms until the app answers; gives up after 60 s or when the signal aborts. */
export async function waitForReady(port: number, signal: AbortSignal, opts: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const f = opts.fetch ?? fetch;
  while (!signal.aborted) {
    try {
      const res = await f(`http://127.0.0.1:${port}/api/local/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (res.ok) {
        const j = (await res.json()) as { bootId?: string };
        if (typeof j.bootId === "string") return j.bootId;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() >= deadline) throw new Error("The app did not start in time");
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 200));
  }
  throw new Error("Startup was cancelled");
}
