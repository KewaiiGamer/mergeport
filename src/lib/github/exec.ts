import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";

/**
 * Running the GitHub CLI as a subprocess, safely.
 *
 * - Arguments are an array handed to the OS; nothing is interpolated into a command line, and no shell is ever used.
 * - Every call has a timeout and an optional AbortSignal. On either, the WHOLE process tree is killed (taskkill /T on
 *   Windows) and the call rejects with a typed error: a stalled `gh` can never hang a page or leak a process.
 * - Every live child is tracked, so shutdown can terminate whatever is still running.
 * - The inherited environment never carries someone else's GitHub token into a child: GH_TOKEN, GITHUB_TOKEN and their
 *   enterprise forms are removed unless the caller passes one explicitly.
 */

export type GhResult = { stdout: string; stderr: string; code: number };
export type GhRunOpts = { input?: string; timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> };
export type GhRunner = (args: string[], opts?: GhRunOpts) => Promise<GhResult>;

export class GhMissingError extends Error {
  constructor(detail = "The GitHub CLI (gh) is not installed or not on PATH") {
    super(detail);
  }
}
export class GhTimeoutError extends Error {
  constructor(ms: number) {
    super(`The GitHub CLI did not answer within ${Math.round(ms / 1000)} seconds`);
  }
}
export class GhAbortedError extends Error {
  constructor() {
    super("The GitHub CLI call was cancelled");
  }
}
/** The account a profile belongs to cannot be used right now. The operation is blocked; nothing falls back to another account. */
export class IdentityError extends Error {
  constructor(readonly reason: "not-signed-in" | "mismatch" | "unsupported-gh", message: string) {
    super(message);
  }
}

const MAX_OUTPUT = 64 * 1024 * 1024;
const INHERITED_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "MERGEPORT_LAUNCH_TOKEN"];

/** Where `gh` usually lives when it is installed but the current process was started before PATH was updated. */
export function ghCandidates(e: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") {
    const join = path.win32.join;
    return [e.ProgramFiles, e["ProgramFiles(x86)"], e.ProgramW6432]
      .filter((x): x is string => !!x)
      .map((d) => join(d, "GitHub CLI", "gh.exe"))
      .concat(e.LOCALAPPDATA ? [join(e.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"), join(e.LOCALAPPDATA, "GitHub CLI", "gh.exe")] : []);
  }
  if (platform === "darwin") return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
  return ["/usr/bin/gh", "/usr/local/bin/gh", "/snap/bin/gh"];
}

/** `.cmd` and `.bat` shims need a shell to run. We never use a shell, so they are refused rather than run unsafely. */
export const needsShell = (file: string) => /\.(cmd|bat)$/i.test(file);

export function configuredCommand(): { file: string; prefix: string[] } | null {
  const override = env().MERGEPORT_GH_CMD;
  if (!override) return null;
  const parts = JSON.parse(override) as string[];
  return { file: parts[0], prefix: parts.slice(1) };
}

/** Looks for an executable on PATH without running anything. On Windows only real executables count (.exe/.com), never shims. */
export function findOnPath(name: string, e: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): string | null {
  const p = platform === "win32" ? path.win32 : path.posix;
  const dirs = (e.PATH ?? e.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? ["", ".exe", ".com"] : [""];
  for (const dir of dirs) for (const ext of exts) {
    const full = p.join(dir.replace(/^"|"$/g, ""), name + ext);
    if (exists(full) && !needsShell(full)) return full;
  }
  return null;
}

/** The command that runs the GitHub CLI: an explicit override, else PATH, else the usual install locations. */
export function ghExecutable(e: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): { file: string; prefix: string[] } | null {
  const cfg = configuredCommand();
  if (cfg) return cfg;
  const found = findOnPath("gh", e, platform, exists) ?? ghCandidates(e, platform).find((c) => exists(c)) ?? null;
  return found ? { file: found, prefix: [] } : null;
}

let cachedExe: { at: number; value: { file: string; prefix: string[] } | null } | undefined;
export const resetGhResolution = () => {
  cachedExe = undefined;
};
const resolveCached = () => {
  if (!cachedExe || Date.now() - cachedExe.at > 60_000 || (!cachedExe.value && Date.now() - cachedExe.at > 2_000)) cachedExe = { at: Date.now(), value: ghExecutable() };
  return cachedExe.value;
};

const live = new Set<ChildProcess>();
export const liveGhProcesses = () => live.size;

/** Kills a child and everything it started. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
    } catch {
      child.kill();
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Terminates every `gh` call still running (shutdown, or a profile being closed). */
export function terminateAllGh(): void {
  for (const c of live) killTree(c);
}

function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of INHERITED_TOKENS) delete e[k];
  return { ...e, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1", ...extra };
}

function run(file: string, prefix: string[], args: string[], opts: GhRunOpts): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    if (needsShell(file)) return reject(new GhMissingError(`${file} is a .cmd/.bat shim, which cannot be run safely without a shell. Point MERGEPORT_GH_CMD at gh.exe.`));
    if (opts.signal?.aborted) return reject(new GhAbortedError());
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let child: ChildProcess;
    try {
      child = spawn(/* turbopackIgnore: true */ file, [...prefix, ...args], { shell: false, windowsHide: true, env: childEnv(opts.env), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new GhMissingError() : e);
    }
    live.add(child);
    let out = "";
    let err = "";
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      live.delete(child);
      fn();
    };
    const stop = (e: Error) => {
      killTree(child);
      finish(() => reject(e));
    };
    const onAbort = () => stop(new GhAbortedError());
    const timer = setTimeout(() => stop(new GhTimeoutError(timeoutMs)), timeoutMs);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const take = (which: "o" | "e") => (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT) return stop(new Error("The GitHub CLI produced too much output"));
      if (which === "o") out += b.toString("utf8");
      else err += b.toString("utf8");
    };
    child.stdout?.on("data", take("o"));
    child.stderr?.on("data", take("e"));
    child.on("error", (e) => finish(() => reject((e as NodeJS.ErrnoException).code === "ENOENT" ? new GhMissingError() : e)));
    child.on("close", (code) => finish(() => resolve({ stdout: out, stderr: err, code: code ?? 1 })));
    child.stdin?.on("error", () => {
      /* the child exited before reading its input */
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Runs `gh` (or the configured override), finding the executable even when this process started before PATH was updated. */
export const defaultGhRunner: GhRunner = async (args, opts = {}) => {
  const exe = resolveCached();
  if (!exe) throw new GhMissingError();
  return run(exe.file, exe.prefix, args, opts);
};
