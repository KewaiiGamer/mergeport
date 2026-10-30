import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadViewer } from "@/lib/authz/viewer";
import { resetGithubEventState } from "@/lib/hub/gh-events";
import { refreshHubWatch } from "@/lib/hub/watch";
import { upsertRepository, removeFromTracking, trackLocally, type RepoMeta } from "@/lib/services/repositories";
import { setStatus } from "@/lib/sync/repository";
import { refreshHubWatch as runtimeRefreshHubWatch } from "@/lib/local/runtime";
import { webhook } from "../github-webhooks";
import { FakeHub, type FakeSocket } from "./fake-hub";
import { makeHubClient, type HubTestClient } from "./harness";
import { ManualTimers } from "./manual-timers";

const meta = (id: bigint, name: string): RepoMeta => ({
  githubId: id, fullName: `octo-org/${name}`, name, htmlUrl: `https://github.com/octo-org/${name}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false,
  owner: { githubId: 583231n, login: "octo-org", type: "ORGANIZATION" },
});
const HELLO = meta(1296269n, "hello-world");
const OTHER = meta(42n, "other");

let hub: FakeHub;
let c: HubTestClient;
let timers: ManualTimers;
let notified: number;
let refreshed: string[];

beforeEach(async () => {
  resetGithubEventState();
  hub = new FakeHub();
  hub.addMember("2", "alice", "MEMBER");
  hub.createSpace("common", "COMMON", "Common");
  await hub.listen();
  c = await makeHubClient(hub, 2n, "alice");
  timers = new ManualTimers();
  notified = 0;
  refreshed = [];
});
afterEach(async () => {
  await c.close();
  await hub.close();
});

const ws = () => c.profile.workspace.id;
const sock = (): FakeSocket => [...hub.sockets][0];
const start = () => c.startLive({ timers, notify: () => void notified++, refreshRepository: async (id) => void refreshed.push(id), now: () => timers.now });
const upTo = async (n: number) => vi.waitFor(() => expect(sock()?.watches.length).toBeGreaterThanOrEqual(n));
const flush = () => new Promise<void>((r) => setTimeout(r, 30));

describe("the live link: watch", () => {
  it("sends the ACTIVE tracked repositories (decimal strings) after hello, not removed or disconnected ones", async () => {
    const a = await upsertRepository(c.db, ws(), HELLO);
    await upsertRepository(c.db, ws(), OTHER);
    await upsertRepository(c.db, ws(), meta(7n, "gone"));
    await upsertRepository(c.db, ws(), meta(8n, "lost"));
    await c.db.repository.update({ where: { workspaceId_githubId: { workspaceId: ws(), githubId: 7n } }, data: { trackingStatus: "REMOVED" } });
    await c.db.repository.update({ where: { workspaceId_githubId: { workspaceId: ws(), githubId: 8n } }, data: { trackingStatus: "DISCONNECTED" } });
    start();
    await upTo(1);
    expect(sock().watches[0]).toEqual(["1296269", "42"]);
    expect(a.githubId).toBe(1296269n);
  });

  it("sends an empty set when nothing is tracked", async () => {
    start();
    await upTo(1);
    expect(sock().watches[0]).toEqual([]);
  });

  it("follows tracking: tracking, untracking and a status change send the new set; an unchanged set is not sent again", async () => {
    start();
    await upTo(1);
    const viewer = (await loadViewer(c.db, c.profile.user.id))!;
    const [row] = await trackLocally(c.db, viewer, [HELLO]);
    await upTo(2);
    expect(sock().watches[1]).toEqual(["1296269"]);
    refreshHubWatch();
    await flush();
    expect(sock().watches).toHaveLength(2); // same set: nothing sent
    await trackLocally(c.db, viewer, [OTHER]);
    await upTo(3);
    expect(sock().watches[2]).toEqual(["1296269", "42"]);
    await setStatus(c.db, row.id, { trackingStatus: "DISCONNECTED", statusDetail: "lost access" });
    await upTo(4);
    expect(sock().watches[3]).toEqual(["42"]);
    await setStatus(c.db, row.id, { trackingStatus: "ACTIVE", statusDetail: null });
    await upTo(5);
    expect(sock().watches[4]).toEqual(["1296269", "42"]);
    await removeFromTracking(c.db, viewer, row.id);
    await upTo(6);
    expect(sock().watches[5]).toEqual(["42"]);
  });

  it("sends the set again on a new connection", async () => {
    await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    const first = sock();
    first.deliverClose(1006);
    timers.advance(5000);
    await vi.waitFor(() => expect(hub.sockets.size).toBe(1));
    await vi.waitFor(() => expect(sock().watches).toEqual([["1296269"]]));
    expect(sock()).not.toBe(first);
  });

  it("the hub only relays to a connection that watches the repository", async () => {
    await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    expect(hub.relayGithub("999", "issues", {})).toBe(0);
    expect(hub.relayGithub("1296269", "issues", {})).toBe(1);
  });

  it("refreshHubWatch is exported by the runtime and is a no-op without a link", () => {
    expect(runtimeRefreshHubWatch).toBe(refreshHubWatch);
    c.live?.stop();
    expect(() => refreshHubWatch()).not.toThrow();
  });
});

describe("the live link: relayed GitHub events", () => {
  it("applies an issue event straight to the local database and says so", async () => {
    await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    const w = webhook("issues-opened");
    hub.relayGithub("1296269", w.event, w.payload);
    await vi.waitFor(() => expect(notified).toBe(1));
    const row = await c.db.workItem.findFirstOrThrow({ where: { number: 7 } });
    expect(row).toMatchObject({ type: "ISSUE", title: "Crash when the config file is empty" });
    expect(refreshed).toEqual([]);
    // the same delivery relayed again is applied once
    hub.relayGithub("1296269", w.event, { ...w.payload, issue: { ...w.payload.issue, title: "Other" } }, "same");
    hub.relayGithub("1296269", w.event, { ...w.payload, issue: { ...w.payload.issue, title: "Third", updated_at: "2026-10-30T23:00:00Z" } }, "same");
    await flush();
    expect(notified).toBe(2);
    expect((await c.db.workItem.findFirstOrThrow({ where: { number: 7 } })).title).toBe("Other");
  });

  it("an event that cannot be applied asks for one coalesced refresh, then redraws", async () => {
    const r = await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    for (let i = 0; i < 5; i++) hub.relayGithub("1296269", "check_run", { action: "completed" }, `cr-${i}`);
    await flush();
    expect(refreshed).toEqual([]); // waits for the 1500 ms window
    timers.advance(1500);
    await vi.waitFor(() => expect(refreshed).toEqual([r.id]));
    await vi.waitFor(() => expect(notified).toBe(1)); // the refresh's completion redraws
  });

  it("ignores events for a repository that is no longer tracked", async () => {
    const r = await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    await c.db.repository.update({ where: { id: r.id }, data: { trackingStatus: "REMOVED" } });
    const w = webhook("issues-opened");
    hub.relayGithub("1296269", w.event, w.payload); // the hub still has the old set
    await flush();
    expect(await c.db.workItem.count()).toBe(0);
    expect(notified).toBe(0);
  });

  it("a malformed relay does not break the link or later events", async () => {
    await upsertRepository(c.db, ws(), HELLO);
    start();
    await upTo(1);
    hub.relayGithub("1296269", "issues", { action: "opened", issue: { number: "x" } });
    const w = webhook("issues-opened");
    hub.relayGithub("1296269", w.event, w.payload);
    await vi.waitFor(() => expect(notified).toBe(1));
    expect(c.live?.link.state).toBe("live");
  });

  it("without a notify option (GitHub-only wiring) an event is still applied and never throws", async () => {
    await upsertRepository(c.db, ws(), HELLO);
    c.startLive({ timers, refreshRepository: async () => {} });
    await upTo(1);
    const w = webhook("issues-opened");
    hub.relayGithub("1296269", w.event, w.payload);
    await vi.waitFor(async () => expect(await c.db.workItem.count()).toBe(1));
  });
});
