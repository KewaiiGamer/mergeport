import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isHubBackend, type Backend } from "@/lib/local/backends";

export type ChildSpec = { dbFile: string; token: string; port: number; demo: boolean; backend?: Backend };
export type ChildHandle = { kill(): Promise<void>; onExit(cb: (code: number | null) => void): void };
export type SupervisorDeps = {
  spawnChild(spec: ChildSpec): ChildHandle;
  /** Resolves the child's boot id once it answers; rejects when the signal aborts. */
  waitReady(port: number, signal: AbortSignal): Promise<string>;
  /** Throws when the workspace cannot be opened (not signed in, hub gone, ...). */
  resolveTarget(req: { backend: Backend }): Promise<{ dbFile: string }>;
  newToken(): string;
  /** Called after a switch fully succeeded (the new child is ready). The launcher records the active workspace here. */
  onSwitched?(backend: Backend): void;
};
type Started = { launchUrl: string; bootId: string };
type Announced = { launchUrl: string; previousBootId: string | null };

/** Carries the caller's own MERGEPORT_LAUNCH_TOKEN; only the current child's token is accepted. */
const TOKEN_HEADER = "x-mergeport-control";
export const NOT_RESTORED = "Could not start the other workspace, and the previous one could not be restored";
const RESTORED = "Could not start the other workspace; the previous one was restored";
const NOT_STOPPED = "The previous workspace did not stop";

/** The target cannot be opened; answered as 409 on the control channel. */
class TargetUnavailableError extends Error {}
/** A different switch is already running; answered as 409 too. */
class SwitchBusyError extends Error {}

type Running = { spec: ChildSpec; handle: ChildHandle; expectedExit: boolean; bootId: string | null; killFailed?: boolean };

/** Owns the one app child process. A switch kills it and starts another, so two children never share the port. */
export class Supervisor {
  private current: Running | null = null;
  /** The child a running switch is replacing: it may still be alive and asking, so its token stays valid until the switch settles. */
  private replacing: ChildSpec | null = null;
  private inflight: { key: string; promise: Promise<Started> } | null = null;
  private control: Server | null = null;
  private stopping = new AbortController();
  private listeners: Array<(code: number | null) => void> = [];
  private failListeners: Array<(err: Error) => void> = [];

  constructor(private deps: SupervisorDeps, private opts: { port: number; demo: boolean; /** Pause between answering a switch request and killing the old child, so its response reaches the browser. Default 400. */ killDelayMs?: number }) {}

  /**
   * "child-exit": a child died outside a switch (the supervisor does not respawn it).
   * "switch-failed": a switch failed AFTER its 202 was sent, so nobody got an HTTP error. The error is NOT_RESTORED when no child is running any more.
   */
  on(event: "child-exit", cb: (code: number | null) => void): void;
  on(event: "switch-failed", cb: (err: Error) => void): void;
  on(event: "child-exit" | "switch-failed", cb: ((code: number | null) => void) | ((err: Error) => void)) {
    if (event === "child-exit") this.listeners.push(cb as (code: number | null) => void);
    else this.failListeners.push(cb as (err: Error) => void);
  }

  start(initial: { dbFile: string; backend?: Backend }): Promise<Started> {
    return this.serialized("start", async () => this.boot({ dbFile: initial.dbFile, backend: initial.backend, token: this.deps.newToken(), port: this.opts.port, demo: this.opts.demo }));
  }

  /** `announce` fires once the target is accepted and BEFORE the current child is killed, so a caller living in that child still gets an answer. */
  switchTo(req: { backend: Backend }, announce?: (a: Announced) => void): Promise<Started> {
    return this.serialized(req.backend, async () => {
      if (this.current?.killFailed) throw new SwitchBusyError(NOT_STOPPED);
      let target: { dbFile: string };
      try {
        target = await this.deps.resolveTarget(req);
      } catch (e) {
        throw new TargetUnavailableError(e instanceof Error ? e.message : "That workspace is not available.");
      }
      const previous = this.current?.spec ?? null;
      this.replacing = previous;
      const next: ChildSpec = { dbFile: target.dbFile, backend: req.backend, token: this.deps.newToken(), port: this.opts.port, demo: this.opts.demo };
      let announced = false;
      if (announce) {
        announce({ launchUrl: launchUrl(next), previousBootId: this.current?.bootId ?? null });
        announced = true;
      }
      try {
        if (announced) await new Promise((r) => setTimeout(r, this.opts.killDelayMs ?? 400));
        await this.killCurrent();
        try {
          const started = await this.boot(next, true);
          try {
            this.deps.onSwitched?.(req.backend);
          } catch {
            /* recording the choice must not undo a working switch */
          }
          return started;
        } catch {
          await this.killCurrent();
          if (previous && !this.stopping.signal.aborted) {
            try {
              await this.boot(previous, true);
            } catch {
              await this.killCurrent();
              throw new Error(NOT_RESTORED);
            }
          }
          throw new Error(RESTORED);
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (announced) this.failListeners.forEach((cb) => cb(err));
        throw err;
      } finally {
        this.replacing = null;
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping.abort();
    await this.inflight?.promise.catch(() => undefined);
    await this.killCurrent().catch(() => undefined); // best effort: shutting down anyway
    const control = this.control;
    this.control = null;
    if (control) await new Promise<void>((resolve) => control.close(() => resolve()));
  }

  /**
   * Loopback-only HTTP endpoint the app child calls to ask for a switch. The child authenticates with its own launch token,
   * so a previous child (or anything that captured an old token) cannot switch once a newer child is running.
   */
  listenControl(): Promise<{ url: string }> {
    if (this.control) return Promise.reject(new Error("Control channel already listening"));
    const server = createServer((req, res) => {
      const reply = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (req.method !== "POST" || req.url !== "/switch") return reply(404, { error: "Not found" });
      if (!this.isCurrentToken(req.headers[TOKEN_HEADER])) return reply(403, { error: "Forbidden" });
      let raw = "";
      let tooBig = false;
      req.on("data", (c: Buffer) => {
        if (tooBig) return;
        raw += c;
        if (raw.length > 4096) {
          tooBig = true;
          reply(413, { error: "Request too large" });
        }
      });
      req.on("end", () => {
        if (tooBig) return;
        const backend = parseBackend(raw);
        if (!backend) return reply(400, { error: "Bad request" });
        // Answer 202 as soon as the switch is accepted: the caller is the very process about to be killed.
        let answered = false;
        const answer = (status: number, body: unknown) => {
          if (answered) return;
          answered = true;
          reply(status, body);
        };
        this.switchTo({ backend }, (a) => answer(202, a)).then(
          (r) => answer(202, { launchUrl: r.launchUrl, previousBootId: null }), // joined a switch already running
          (e) => (e instanceof TargetUnavailableError || e instanceof SwitchBusyError ? answer(409, { error: e.message }) : answer(500, { error: e instanceof Error ? e.message : "Switch failed" })),
        );
      });
    });
    this.control = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") return reject(new Error("Control channel failed to bind"));
        resolve({ url: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  /** True for the current child's launch token (and, while a switch is running, the token of the child it replaces). */
  private isCurrentToken(got: string | string[] | undefined): boolean {
    if (typeof got !== "string") return false;
    const a = Buffer.from(got);
    const accepted = [this.current?.spec.token, this.replacing?.token].filter((t): t is string => typeof t === "string");
    let ok = false;
    for (const t of accepted) {
      const b = Buffer.from(t);
      if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
    }
    return ok;
  }

  /** One operation at a time; the same request arriving mid-flight shares its promise, a different one is refused. */
  private serialized(key: string, fn: () => Promise<Started>): Promise<Started> {
    if (this.inflight) {
      if (this.inflight.key === key) return this.inflight.promise;
      return Promise.reject(new SwitchBusyError("Another workspace switch is in progress"));
    }
    const promise = fn().finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { key, promise };
    return promise;
  }

  /** `quiet`: a switch is handling this boot, so a child dying before it is ready is not reported as "child-exit". */
  private async boot(spec: ChildSpec, quiet = false): Promise<Started> {
    const run: Running = { spec, handle: this.deps.spawnChild(spec), expectedExit: quiet, bootId: null };
    this.current = run;
    // Aborting on exit lets waitReady fail fast when the child dies while booting.
    const boot = new AbortController();
    const abort = () => boot.abort();
    this.stopping.signal.addEventListener("abort", abort, { once: true });
    run.handle.onExit((code) => {
      boot.abort();
      if (this.current === run) this.current = null;
      if (!run.expectedExit) this.listeners.forEach((cb) => cb(code));
    });
    try {
      const bootId = await this.deps.waitReady(spec.port, boot.signal);
      run.expectedExit = false;
      run.bootId = bootId;
      return { launchUrl: launchUrl(spec), bootId };
    } finally {
      this.stopping.signal.removeEventListener("abort", abort);
    }
  }

  private async killCurrent() {
    const run = this.current;
    if (!run) return;
    run.expectedExit = true;
    try {
      await run.handle.kill();
    } catch {
      // The old process may still hold the port: keep the handle and refuse further switches until it is gone.
      run.killFailed = true;
      throw new Error(NOT_STOPPED);
    }
    if (this.current === run) this.current = null;
  }
}

const launchUrl = (spec: ChildSpec) => `http://127.0.0.1:${spec.port}/api/local/launch?token=${spec.token}`;

function parseBackend(raw: string): Backend | null {
  try {
    const b = (JSON.parse(raw) as { backend?: unknown }).backend;
    return typeof b === "string" && (b === "github" || isHubBackend(b)) ? (b as Backend) : null;
  } catch {
    return null;
  }
}

/** Asks the supervisor for a switch, authenticated with a launch token (a getter, since the current token changes on every switch). */
export class ControlClient {
  constructor(private url: string, private token: string | (() => string)) {}

  async switchTo(backend: Backend): Promise<{ launchUrl: string; previousBootId: string | null }> {
    const res = await fetch(`${this.url}/switch`, {
      method: "POST",
      headers: { "content-type": "application/json", [TOKEN_HEADER]: typeof this.token === "string" ? this.token : this.token() },
      body: JSON.stringify({ backend }),
    });
    const body = (await res.json().catch(() => ({}))) as { launchUrl?: string; previousBootId?: string | null; error?: string };
    if (!res.ok || !body.launchUrl) throw new Error(body.error ?? `Switch failed (${res.status})`);
    return { launchUrl: body.launchUrl, previousBootId: body.previousBootId ?? null };
  }
}
