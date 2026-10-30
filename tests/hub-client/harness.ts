import fs from "node:fs";
import path from "node:path";
import type { Space } from "@/generated/prisma/client";
import { createPrisma, type Db } from "@/lib/db";
import { HttpHubClient } from "@/lib/hub/client";
import type { SocketLike, Timers } from "@/lib/hub/link";
import { startHubLive } from "@/lib/hub/live";
import { syncHubSpaces } from "@/lib/hub/spaces";
import { ensureLocalProfile } from "@/lib/local/profile";
import { SyncEngine } from "@/lib/sync/engine";
import { clock } from "../harness";
import type { FakeHub } from "./fake-hub";

/** An isolated local Mergeport client signed in to a FakeHub as one member. `hub.listen()` must have been called. */
export type HubTestClient = Awaited<ReturnType<typeof makeHubClient>>;

let counter = 0;

export async function makeHubClient(hub: FakeHub, githubId: bigint, login: string, opts: { events?: { spaceId: string; reason: string }[] } = {}) {
  const file = path.resolve(".data", `hubclient-${login}-${process.pid}-${counter++}.db`);
  for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(file + sfx, { force: true });
  const db: Db = createPrisma(file);
  const actor = { id: githubId, login };
  const profile = await ensureLocalProfile(db, { id: githubId, login, name: login, avatarUrl: null, host: "github.com" });
  const token = hub.token(String(githubId));
  const origin = hub.origin();
  await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", backend: "HUB", hubOrigin: origin }, update: { mode: "TEAM", backend: "HUB", hubOrigin: origin } });
  const client = new HttpHubClient(origin, async () => token);
  let liveHandle: ReturnType<typeof startHubLive> | null = null;
  const engine = new SyncEngine({
    db, actor, now: clock.now, random: () => 0.5,
    store: () => {
      throw new Error("GitHub store used in a hub test");
    },
    hub: () => client,
    hubLive: () => liveHandle?.live() ?? false,
    onChange: (e) => opts.events?.push(e),
  });
  const space = (hubSpaceId: string): Promise<Space> => db.space.findFirstOrThrow({ where: { backend: "HUB", hubSpaceId } });
  /** me() -> syncHubSpaces -> syncSpace for every hub space. A failing me() (offline, signed out, removed) does not stop the spaces from syncing. */
  const sync = async () => {
    try {
      await syncHubSpaces(db, engine, await client.me());
    } catch {
      // the per-space cycle below records and maps the failure
    }
    for (const s of await db.space.findMany({ where: { backend: "HUB" } })) await engine.syncSpace(s);
  };
  /** Starts the live link against the FakeHub (in-memory sockets); the engine's hubLive reads it. */
  const startLive = (o: { timers?: Timers; random?: () => number; getToken?: () => Promise<string | null>; connect?: (url: string, protocols: string[]) => SocketLike; notify?: () => void; refreshRepository?: (repositoryId: string) => Promise<void>; now?: () => number } = {}) => {
    liveHandle?.stop();
    liveHandle = startHubLive({
      db, engine, client, origin, getToken: o.getToken ?? (async () => token), timers: o.timers, random: o.random ?? (() => 0.5),
      notify: o.notify, refreshRepository: o.refreshRepository, now: o.now,
      connect: o.connect ?? ((_url, protocols) => hub.socket(protocols.find((p) => p.startsWith("bearer."))?.slice(7) ?? "")),
    });
    return liveHandle;
  };
  return {
    login, db, file, actor, engine, profile, client, token, sync, space, startLive,
    get live() {
      return liveHandle;
    },
    close: async () => {
      liveHandle?.stop();
      await db.$disconnect();
    },
  };
}

/** Entity data exactly as `entityDef.list` produces it for a project / card, so a pulled entity never looks like a local edit. */
export const projectData = (name: string, slug = name.toLowerCase().replace(/\W+/g, "-")) => ({ name, slug, description: null, repoIds: [] as string[] });
export const cardData = (projectId: string, title: string, columnKey = "ready") => ({
  projectId, columnKey, position: 1024, title, description: null, workRepoGithubId: null, workNumber: null, assigneeLogin: null, assignedByLogin: null, authorLogin: null,
  labels: [] as string[], priority: 0, due: null, milestoneId: null, blockedBy: [] as string[],
});
