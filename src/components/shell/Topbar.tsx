"use client";

import { RingOnChange } from "@/components/ui/RingOnChange";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ChevronRight, LayoutDashboard, LogOut } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/shell/ThemeControls";
import { WorkspaceSwitcher } from "@/components/shell/WorkspaceSwitcher";
import type { WorkspaceEntry } from "@/lib/local/workspaces";
import { Tip } from "@/components/ui/Tooltip";
import { Metric } from "@/components/ui/Metric";
import { SyncBadge, type SyncStateName } from "@/components/sync/SyncBadge";
import type { ThemePreference } from "@/lib/theme";

const LABELS: Record<string, string> = {
  attention: "My attention",
  "pull-requests": "Pull requests",
  issues: "Issues",
  planning: "Planning",
  tasks: "Tasks",
  activity: "Activity",
  repositories: "Repositories",
  connect: "Connect repositories",
  forks: "Forks & upstream",
  branches: "Branches & worktrees",
  admin: "Administration",
  team: "Team",
  sync: "Sync",
  join: "Join a space",
  projects: "Projects",
  rules: "Review routing",
  settings: "Settings",
  search: "Search",
};

export function Topbar({ unread, menu, syncNote, theme, sync, workspaces }: { unread: number; menu: React.ReactNode; syncNote?: string; theme: ThemePreference; sync: { state: SyncStateName; pending: number; conflicts: number; detail?: string | null; scope?: "source" } | null; workspaces?: { entries: WorkspaceEntry[]; active: string; switchable: boolean } | null }) {
  const path = usePathname();
  const parts = path.split("/").filter(Boolean);
  const crumbs = parts.map((p, i) => ({ href: "/" + parts.slice(0, i + 1).join("/"), label: LABELS[p] ?? (p.length > 16 ? "Detail" : p) }));
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/90 px-4 backdrop-blur-sm lg:px-6">
      {menu}
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-3">
          <li className="flex shrink-0 items-center gap-1.5">
            <Link href="/" className="inline-flex items-center gap-1.5 hover:text-ink" aria-label="Overview">
              <LayoutDashboard size={14} aria-hidden />
              <span className="hidden sm:inline">Overview</span>
            </Link>
          </li>
          {crumbs.map((c, i) => (
            <li key={c.href} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight size={12} aria-hidden className="shrink-0" />
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="truncate font-medium text-ink">{c.label}</span>
              ) : (
                <Link href={c.href} className="truncate hover:text-ink">{c.label}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {workspaces ? <WorkspaceSwitcher {...workspaces} /> : null}
      {syncNote && <span className="hidden text-[12px] text-ink-3 md:inline">{syncNote}</span>}
      {sync && <SyncBadge {...sync} href="/sync" />}
      <ThemeToggle initial={theme} />
      <Tip label={unread ? `Notifications (${unread} unread)` : "Notifications"}>
        <RingOnChange value={unread}>{(ring) => (
        <Link href="/activity" className="btn btn-quiet btn-icon bell-link relative" data-ring={ring ? "true" : undefined} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}>
          <Bell size={16} aria-hidden />
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] leading-4 text-ink-invert"><Metric value={unread} /></span>}
        </Link>
        )}</RingOnChange>
      </Tip>
      <form action="/api/local/signout" method="post">
        <Tip label="Sign out of this browser session"><button className="btn btn-quiet btn-icon" aria-label="Sign out"><LogOut size={16} aria-hidden /></button></Tip>
      </form>
    </header>
  );
}
