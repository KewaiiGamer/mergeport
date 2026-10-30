/**
 * Starts Mergeport locally:  npm run local   (or  npm run local:demo  for synthetic data without GitHub)
 *
 * - works out WHO is signed in to the GitHub CLI and opens that account's own profile database
 *   (~/.mergeport/profiles/<host>-<account id>/mergeport.db), so accounts never share data;
 * - binds the server to 127.0.0.1 only;
 * - opens your browser on a one-time launch link that binds that browser to this process.
 * No database server, Docker, tunnel or inbound network access is needed.
 */
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrisma } from "../src/lib/db";
import { ghStatus, loginCommand, REQUIRED_SCOPES } from "../src/lib/github/gh";
import { mergeportHome } from "../src/lib/local/profile";
import { writeActive } from "../src/lib/local/registry";
import { resolveStartProfile, resolveSwitchTarget } from "../src/lib/local/start-profile";
import { spawnNext, waitForReady } from "../src/lib/local/child-process";
import type { Backend } from "../src/lib/local/backends";
import { NOT_RESTORED, Supervisor } from "../src/lib/local/supervisor";
import { looksOffline, savedProfiles } from "../src/lib/local/saved-profiles";
import { seedDemo } from "../src/lib/demo/seed";

const args = process.argv.slice(2);
const demo = args.includes("--demo");
const noOpen = args.includes("--no-open");
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.MERGEPORT_PORT) || 3000;
const host = process.env.MERGEPORT_HOST ?? "github.com";

async function main() {
  const home = mergeportHome(process.env.MERGEPORT_HOME);
  let dbFile: string;
  let startBackend: Backend = "github";
  let signedInId: bigint | null = null; // who gh is (or, offline, who the saved profile is); switching only opens this account's profiles
  if (demo) {
    dbFile = path.join(home, "demo", "mergeport-demo.db");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = createPrisma(dbFile);
    if ((await db.user.count()) === 0) await seedDemo(db);
    await db.$disconnect();
    console.log("Demo mode: synthetic data, no GitHub access.");
  } else {
    const st = await ghStatus(undefined, host);
    if (st.state === "missing-gh") {
      console.error("The GitHub CLI (gh) is required. Install it from https://cli.github.com/ (Windows: winget install GitHub.cli), then run this again.");
      process.exit(2);
    }
    if (st.state === "not-logged-in") {
      console.error(`You are not signed in to GitHub. Run:\n\n  ${loginCommand(host)}\n\nThis asks GitHub for the scopes ${REQUIRED_SCOPES.join(", ")}. “repo” is broad read/write access to repositories you can reach, not a read-only permission. gh stores the token in your OS credential store; Mergeport never reads it.`);
      process.exit(2);
    }
    if (st.state === "error") {
      // GitHub being unreachable must not lock a person out of data already on this computer. With exactly one saved profile
      // the app opens it read-and-edit locally; nothing is sent to GitHub until the account is verified by numeric id again.
      const saved = looksOffline(st.message) ? savedProfiles(home, host) : [];
      if (saved.length !== 1) {
        console.error("Could not ask GitHub who you are: " + st.message + (looksOffline(st.message) ? (saved.length > 1 ? "\nSeveral saved profiles exist, so Mergeport cannot pick one without GitHub. Connect to the network and run this again." : "\nThere is no saved profile on this computer yet, so there is nothing to open offline. Connect to the network and run this again.") : ""));
        process.exit(2);
      }
      dbFile = saved[0].dbFile;
      signedInId = BigInt(saved[0].id);
      createPrisma(dbFile); // applies migrations
      console.log(`GitHub is unreachable (${st.message}). Opening the saved profile for @${saved[0].login} (id ${saved[0].id}) from this computer: ${dbFile}\nData is shown as last saved. Nothing is sent to GitHub until the account is verified again.`);
    } else {
      signedInId = st.identity.id;
      const prof = resolveStartProfile(home, host, st.identity.id);
      dbFile = prof.dbFile;
      startBackend = prof.backend;
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      createPrisma(dbFile); // applies migrations
      console.log(`Signed in to ${host} as ${st.identity.login} (id ${st.identity.id}). Profile: ${dbFile}`);
    }
  }

  const next = path.join("node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(".next/BUILD_ID")) {
    console.log("First run: building the app (one time)…");
    const buildEnv = { ...process.env, MERGEPORT_DB: dbFile, MERGEPORT_PORT: String(port), DEMO_MODE: demo ? "true" : "false", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    await new Promise<void>((resolve, reject) => spawn(process.execPath, [next, "build"], { stdio: "inherit", env: buildEnv }).on("exit", (c) => (c === 0 ? resolve() : reject(new Error("build failed")))));
  }

  // The supervisor owns the one app process, so a workspace switch is a restart on another database, never an in-process swap.
  const control = { url: "" };
  const supervisor = new Supervisor(
    {
      spawnChild: (spec) => spawnNext(spec, { MERGEPORT_CONTROL_URL: control.url }),
      waitReady: (p, signal) => waitForReady(p, signal),
      resolveTarget: async ({ backend }) => {
        if (demo || signedInId === null) throw new Error("Switching workspaces is not available in this mode.");
        return resolveSwitchTarget(home, host, signedInId, backend);
      },
      // The launcher owns active.json: it changes only once the new workspace is really up.
      onSwitched: (backend) => {
        if (signedInId !== null) writeActive(home, { host, accountId: String(signedInId), backend });
      },
      newToken: () => randomBytes(24).toString("base64url"),
    },
    { port, demo },
  );
  Object.assign(control, await supervisor.listenControl());
  // Stop the whole tree (the server AND any gh it is running) so nothing outlives the launcher. On Windows a plain kill would orphan them.
  const stop = () => void supervisor.stop().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // A child that dies outside a switch ends the launcher, as before.
  supervisor.on("child-exit", (c) => process.exit(c ?? 0));
  // A switch that failed after the browser was told it was accepted has no other way to be reported.
  supervisor.on("switch-failed", (err) => {
    console.error(err.message);
    if (err.message === NOT_RESTORED) void supervisor.stop().finally(() => process.exit(1)); // no child is running any more
  });

  const started = Date.now();
  const { launchUrl: url } = await supervisor.start({ dbFile, backend: startBackend }).catch(async (e) => {
    await supervisor.stop();
    throw e;
  });
  setTimeout(() => {
    console.log(`\nMergeport is running at http://127.0.0.1:${port} (this computer only).`);
    if (demo) console.log("Demo sign-in is on the sign-in page.");
    if (!noOpen) {
      const [cmd, a] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      execFile(cmd as string, a as string[], () => {});
    } else console.log("Open this one-time link:\n" + url);
  }, Math.max(0, 2500 - (Date.now() - started)));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
