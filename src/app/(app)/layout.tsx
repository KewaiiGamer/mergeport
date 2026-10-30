import { processStartedAt } from "@/lib/local/boot";
import { Suspense } from "react";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/current";
import { repoWhere } from "@/lib/authz/viewer";
import { attentionFor } from "@/lib/services/request-cache";
import { planningWhere, unreadNotificationCount } from "@/lib/services/queries";
import { formatInstant } from "@/lib/format";
import { MobileNav, Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { LiveRefresh } from "@/components/sync/LiveRefresh";
import { SyncAnnouncer } from "@/components/sync/SyncAnnouncer";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { SyncStateName } from "@/components/sync/SyncBadge";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { checkProfile } from "@/lib/local/identity";
import { getEngine } from "@/lib/local/runtime";
import { deriveSourceStatus } from "@/lib/sync/source-status";
import { env, isDemo } from "@/lib/env";
import { mergeportHome } from "@/lib/local/profile";
import { listWorkspaces } from "@/lib/local/workspaces";
import Link from "next/link";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { viewer, user } = await requireViewer();
  const [q, unread, ws, lastSync, demoRepos] = await Promise.all([
    attentionFor(viewer),
    unreadNotificationCount(db, viewer),
    db.workspace.findUniqueOrThrow({ where: { id: viewer.workspaceId } }),
    db.repository.aggregate({ where: repoWhere(viewer), _max: { lastSyncedAt: true } }),
    db.repository.count({ where: { ...repoWhere(viewer), isDemo: true } }),
  ]);
  const counts = {
    needsMyReview: q.needsMyReview.length,
    needsTeam: q.needsTeamReview.length,
    waiting: q.waitingExternal.length,
    changes: q.changesRequested.length,
    blocked: q.blocked.length,
    tasks: await db.planningItem.count({ where: { AND: [await planningWhere(db, viewer), { assigneeLogin: viewer.login, column: { key: { not: "done" } } }] } }),
  };
  const last = lastSync._max.lastSyncedAt;
  const profile = await checkProfile(); // last known answer; refreshed in the background, never waits on gh
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const [spaceCount, conflictRows, restoreRows, quarantined, pendingOps, offlineSpaces] = await Promise.all([
    db.space.count(),
    db.syncConflict.count({ where: { status: "OPEN" } }),
    // A restored server needs a decision (send my copies again, or keep the server's), like a conflict does.
    db.hubRestore.count({ where: { status: "OPEN" } }),
    db.outboxOp.count({ where: { status: "QUARANTINED" } }),
    db.outboxOp.count({ where: { status: { in: ["PENDING", "SENT", "FAILED"] } } }),
    db.space.count({ where: { lastError: "offline" } }),
  ]);
  const openConflicts = conflictRows + restoreRows;
  // The single state shown in the top bar is the MOST SEVERE one across spaces (what needs a person comes first).
  const SEVERITY: SyncStateName[] = ["conflict", "revoked", "signin", "schema", "rate-limited", "offline", "reconnecting", "syncing", "pending", "read-only", "synced"];
  let aggregate: SyncStateName = openConflicts ? "conflict" : quarantined ? "revoked" : offlineSpaces ? "offline" : pendingOps ? "pending" : "synced";
  const engine = await getEngine();
  if (engine && spaceCount > 0) {
    const states = await Promise.all((await db.space.findMany()).map(async (s) => (await engine.stateFor(s)).state as SyncStateName));
    aggregate = states.sort((x, y) => SEVERITY.indexOf(x) - SEVERITY.indexOf(y))[0] ?? aggregate;
  }
  if (restoreRows) aggregate = "conflict";
  // Refreshing tracked source repositories is real work too, and it exists with no team space at all.
  // A job still marked RUNNING by a process that died is not work in progress; it is reclaimed on a timer.
  const bootAt = processStartedAt();
  const own = { workspaceId: viewer.workspaceId, isDemo: false, trackingStatus: { not: "REMOVED" as const } };
  const [tracked, running, queued, refused, rateLimited, failed, neverSynced] = await Promise.all([
    db.repository.count({ where: own }),
    db.job.count({ where: { type: "sync.repository", status: "RUNNING", lockedAt: { gte: bootAt } } }),
    db.job.count({ where: { type: "sync.repository", status: "QUEUED" } }),
    db.repository.count({ where: { ...own, trackingStatus: "DISCONNECTED" } }),
    db.repository.count({ where: { ...own, rateLimited: true } }),
    db.repository.count({ where: { ...own, trackingStatus: "ACTIVE", rateLimited: false, syncError: { not: null } } }),
    db.repository.count({ where: { ...own, lastSyncedAt: null } }),
  ]);
  const source = deriveSourceStatus({ tracked, running, queued, refused, rateLimited, failed, neverSynced });
  const candidates: { state: SyncStateName; pending: number; conflicts: number; detail?: string; scope?: "source" }[] = [];
  if (spaceCount > 0) candidates.push({ state: aggregate, pending: pendingOps, conflicts: openConflicts });
  if (source) candidates.push({ state: source.state, pending: 0, conflicts: 0, detail: source.detail, scope: "source" });
  const sync = candidates.sort((x, y) => SEVERITY.indexOf(x.state) - SEVERITY.indexOf(y.state))[0] ?? null;
  // Switching needs the launcher's control channel; without it (plain dev server) the label is static, and demo shows nothing.
  const switchable = Boolean(process.env.MERGEPORT_CONTROL_URL);
  const wsList = isDemo() ? null : listWorkspaces(mergeportHome(env().MERGEPORT_HOME), env().MERGEPORT_HOST, user.githubId.toString());
  const workspaces = wsList && { ...wsList, switchable };
  const navProps = { counts, isAdmin: viewer.isAdmin, user: { login: user.login, name: user.name, avatarUrl: user.avatarUrl }, workspace: ws.name };
  return (
    <TooltipProvider>
    <ToastProvider>
    <div className="mx-auto flex min-h-dvh max-w-[3200px]">
      <LiveRefresh />
      <SyncAnnouncer state={sync?.state ?? null} />
      <Suspense fallback={<aside className="hidden w-[250px] shrink-0 lg:block" />}>
        <Sidebar {...navProps} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-14" />}>
          <Topbar workspaces={workspaces} unread={unread} theme={theme} sync={sync} menu={<MobileNav {...navProps} />} syncNote={last ? `Last refresh ${formatInstant(last, viewer.timezone)}` : "Not refreshed yet"} />
        </Suspense>
        {profile.kind === "mismatch" && (
          <div className="border-b border-line bg-subtle px-4 py-1.5 text-[12px] text-ink-2 lg:px-6" role="note">
            The GitHub CLI has @{profile.ghLogin} selected. This profile keeps acting only as @{profile.profileLogin}, using that account&apos;s own sign-in; if it is not signed in, nothing is sent and you will be asked to reconnect. <Link className="underline" href="/account-changed">Details</Link>
          </div>
        )}
        {profile.kind === "gh-unavailable" && (
          <div className="border-b border-line bg-subtle px-4 py-1.5 text-[12px] text-ink-2 lg:px-6" role="note">
            GitHub is not available right now ({profile.gh.state === "missing-gh" ? "the GitHub CLI was not found" : profile.gh.state === "not-logged-in" ? "gh is not signed in" : "gh did not answer"}). Saved data is shown and edits are kept on this computer; nothing is sent until it is back.
          </div>
        )}
        {demoRepos > 0 && (
          <div className="border-b border-line bg-subtle px-4 py-1.5 text-[12px] text-ink-2 lg:px-6" role="note">
            Demo mode: {demoRepos} repositor{demoRepos === 1 ? "y" : "ies"} hold synthetic data. Actions change the demo database only; nothing is sent to GitHub.
          </div>
        )}
        <main id="main" className="min-w-0 flex-1 px-4 pb-16 pt-6 lg:px-6">{children}</main>
      </div>
    </div>
    </ToastProvider>
    </TooltipProvider>
  );
}
