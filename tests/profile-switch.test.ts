import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrisma } from "@/lib/db";
import { assertBackendMatch } from "@/lib/local/backend-guard";
import { waitForReady } from "@/lib/local/child-process";
import { pollSwitch, validateSwitchTarget, type Ready } from "@/lib/local/switch-poll";
import { ControlClient, Supervisor, type ChildHandle, type ChildSpec } from "@/lib/local/supervisor";
import type { Backend } from "@/lib/local/backends";
import { ValidationError } from "@/lib/errors";

const HUB: Backend = "hub-0123456789abcdef";
const FAKE = path.resolve("tests/fixtures/fake-child.mjs");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Token of the child most recently spawned: what the current app process would send from its own environment. */
let currentToken = "";
function spawnFake(spec: ChildSpec): ChildHandle {
  currentToken = spec.token;
  const child = spawn(process.execPath, [FAKE], {
    stdio: "ignore",
    env: { ...process.env, MERGEPORT_DB: spec.dbFile, MERGEPORT_LAUNCH_TOKEN: spec.token, MERGEPORT_PORT: String(spec.port), MERGEPORT_BACKEND: spec.backend ?? "github" },
  });
  let exited = false;
  const cbs: Array<(c: number | null) => void> = [];
  child.once("exit", (c) => {
    exited = true;
    cbs.forEach((cb) => cb(c));
  });
  return {
    kill: () =>
      exited
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill();
          }),
    onExit: (cb) => cbs.push(cb),
  };
}

let dir: string;
let sup: Supervisor | null = null;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mp-switch-"));
});
afterEach(async () => {
  await sup?.stop();
  sup = null;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const port = await freePort();
  const ghFile = path.join(dir, "github.db");
  const hubFile = path.join(dir, "hub.db");
  const files: Record<string, string> = { github: ghFile, [HUB]: hubFile };
  const gh = createPrisma(ghFile);
  const hub = createPrisma(hubFile);
  await gh.workspace.create({ data: { name: "GitHub project" } });
  await hub.workspace.create({ data: { name: "Hub project" } });
  await gh.$disconnect();
  await hub.$disconnect();
  sup = new Supervisor(
    {
      spawnChild: spawnFake,
      waitReady: (p, signal) => waitForReady(p, signal, { timeoutMs: 15_000, intervalMs: 50 }),
      resolveTarget: async ({ backend }) => ({ dbFile: files[backend] }),
      newToken: () => randomBytes(8).toString("hex"),
    },
    { port, demo: false, killDelayMs: 20 },
  );
  const first = await sup.start({ dbFile: ghFile, backend: "github" });
  const { url } = await sup.listenControl();
  return { port, ghFile, hubFile, first, client: new ControlClient(url, () => currentToken) };
}

/** Follows a launch link by hand and returns the session cookie, or the failing status. */
async function launch(launchUrl: string): Promise<{ status: number; cookie: string }> {
  const res = await fetch(launchUrl, { redirect: "manual" });
  return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}
const whoami = async (port: number, cookie: string) => {
  const res = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { cookie } });
  return res.status === 200 ? ((await res.json()) as { db: string }).db : res.status;
};
const ready = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/api/local/ready`)).json()) as Ready;
async function names(file: string) {
  const db = createPrisma(file, { migrate: false });
  try {
    return (await db.workspace.findMany()).map((w) => w.name);
  } finally {
    await db.$disconnect();
  }
}
async function switchAndWait(client: ControlClient, port: number, backend: Backend) {
  // The previous switch's supervisor bookkeeping may still be finishing right after its child became ready.
  let r = await client.switchTo(backend).catch(() => null);
  for (let n = 0; !r && n < 40; n++) {
    await new Promise((res) => setTimeout(res, 50));
    r = await client.switchTo(backend).catch(() => null);
  }
  if (!r) throw new Error("switch was never accepted");
  const outcome = await pollSwitch({ fetchReady: () => ready(port), previousBootId: r.previousBootId, expectedBackend: backend, intervalMs: 50, timeoutMs: 15_000 });
  return { ...r, outcome };
}

describe("profile switching with real processes", () => {
  it("launch link signs in on the new child, is single use, and the old one is dead", async () => {
    const { port, ghFile, hubFile, first, client } = await setup();
    const a = await launch(first.launchUrl);
    expect(a.status).toBe(302);
    expect(await whoami(port, a.cookie)).toBe(ghFile);

    const r = await switchAndWait(client, port, HUB);
    expect(r.outcome).toBe("go-launch");
    expect((await ready(port)).bootId).not.toBe(first.bootId);
    expect(r.previousBootId).toBe(first.bootId);

    const b = await launch(r.launchUrl);
    expect(b.status).toBe(302);
    expect(await whoami(port, b.cookie)).toBe(hubFile);
    expect((await launch(r.launchUrl)).status).toBe(403);
    expect((await launch(first.launchUrl)).status).toBe(403);
    expect(await whoami(port, a.cookie)).toBe(401);
  }, 30_000);

  it("keeps data isolated when switching back and forth twice", async () => {
    const { port, ghFile, hubFile, client } = await setup();
    for (const backend of [HUB, "github", HUB, "github"] as Backend[]) {
      const r = await switchAndWait(client, port, backend);
      expect(r.outcome).toBe("go-launch");
      const c = await launch(r.launchUrl);
      expect(await whoami(port, c.cookie)).toBe(backend === "github" ? ghFile : hubFile);
      expect(await names(ghFile)).toEqual(["GitHub project"]);
      expect(await names(hubFile)).toEqual(["Hub project"]);
    }
  }, 30_000);
});

describe("assertBackendMatch", () => {
  it("rejects mismatches and accepts matching pairs", () => {
    expect(() => assertBackendMatch({ backend: HUB }, { backend: "GITHUB" })).toThrow(ValidationError);
    expect(() => assertBackendMatch({ backend: "github" }, { backend: "HUB" })).toThrow(ValidationError);
    expect(() => assertBackendMatch({ backend: "github" }, { backend: "GITHUB" })).not.toThrow();
    expect(() => assertBackendMatch({ backend: HUB }, { backend: "HUB" })).not.toThrow();
  });
});

describe("validateSwitchTarget", () => {
  const ok = "http://127.0.0.1:4100/api/local/launch?token=abc";
  it("accepts only the launch url on the own host", () => {
    expect(validateSwitchTarget(ok, "127.0.0.1:4100")).toBe(true);
    expect(validateSwitchTarget(ok, "127.0.0.1:4101")).toBe(false);
    expect(validateSwitchTarget("http://evil.example:4100/api/local/launch?token=abc", "evil.example:4100")).toBe(false);
    expect(validateSwitchTarget("https://127.0.0.1:4100/api/local/launch?token=abc", "127.0.0.1:4100")).toBe(false);
    expect(validateSwitchTarget("http://127.0.0.1:4100/other?token=abc", "127.0.0.1:4100")).toBe(false);
    expect(validateSwitchTarget("http://127.0.0.1:4100/api/local/launch", "127.0.0.1:4100")).toBe(false);
    expect(validateSwitchTarget("http://user@127.0.0.1:4100/api/local/launch?token=abc", "127.0.0.1:4100")).toBe(false);
    expect(validateSwitchTarget("//evil.example/x", "127.0.0.1:4100")).toBe(false);
    expect(validateSwitchTarget("javascript:alert(1)", "127.0.0.1:4100")).toBe(false);
  });
});

describe("pollSwitch", () => {
  const noSleep = async () => {};
  const seq = (...steps: Array<Ready | "err">) => {
    let i = 0;
    return async () => {
      const s = steps[Math.min(i++, steps.length - 1)];
      if (s === "err") throw new Error("down");
      return s;
    };
  };
  const base = { intervalMs: 1, sleep: noSleep };

  it("go-launch: new boot id with the expected backend", async () => {
    const fetchReady = seq({ bootId: "a", backend: "github" }, "err", "err", { bootId: "b", backend: HUB });
    expect(await pollSwitch({ ...base, fetchReady, previousBootId: "a", expectedBackend: HUB })).toBe("go-launch");
  });
  it("restored: new boot id with another backend", async () => {
    const fetchReady = seq("err", { bootId: "c", backend: "github" });
    expect(await pollSwitch({ ...base, fetchReady, previousBootId: "a", expectedBackend: HUB })).toBe("restored");
  });
  it("timeout when nothing new ever answers", async () => {
    const fetchReady = seq({ bootId: "a", backend: "github" });
    expect(await pollSwitch({ ...base, fetchReady, previousBootId: "a", expectedBackend: HUB, timeoutMs: 20 })).toBe("timeout");
  });
  it("null previous: first success before any error is the old process", async () => {
    const fetchReady = seq({ bootId: "a", backend: "github" }, { bootId: "a", backend: "github" }, "err", { bootId: "b", backend: HUB });
    expect(await pollSwitch({ ...base, fetchReady, previousBootId: null, expectedBackend: HUB })).toBe("go-launch");
    const stuck = seq({ bootId: "a", backend: "github" });
    expect(await pollSwitch({ ...base, fetchReady: stuck, previousBootId: null, expectedBackend: HUB, timeoutMs: 20 })).toBe("timeout");
  });
  it("null previous: any success after an error is a new boot", async () => {
    const fetchReady = seq("err", { bootId: "x", backend: HUB });
    expect(await pollSwitch({ ...base, fetchReady, previousBootId: null, expectedBackend: HUB })).toBe("go-launch");
  });
});
