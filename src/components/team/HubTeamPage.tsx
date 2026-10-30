import { requireViewer } from "@/lib/authz-page";
import { db } from "@/lib/db";
import { readCoverage } from "@/lib/hub/github-app-install";
import { InstantUpdatesPanel, type GithubAppResult, type TrackedRow } from "@/components/team/InstantUpdatesPanel";
import { HubForbidden, HubUnauthorized, type HubLinkStatus } from "@/lib/hub/ports";
import { hubLinkStatus } from "@/lib/hub/ports-impl";
import { getHubTeamService } from "@/lib/local/runtime";
import type { HubAdminSpace } from "@/lib/hub/ports";
import type { HubOverview } from "@/lib/team/hub-service";
import { HubTeamPanel, type HubTeamError } from "@/components/team/HubTeamPanel";

/**
 * The "Instant GitHub updates" panel: what the hub says (`/me.webhooks`, already in the overview) plus this profile's tracked
 * repositories and the last known coverage, both from the local database. No GitHub request is made while rendering. A local
 * database problem leaves the lists empty rather than breaking the Team page.
 */
async function instantUpdatesPanel({ overview, origin, viewerWorkspaceId, githubApp }: { overview: HubOverview; origin: string | null; viewerWorkspaceId: string | undefined; githubApp?: GithubAppResult | null }) {
  let tracked: TrackedRow[] = [];
  let covered = new Set<string>();
  try {
    const rows = await db.repository.findMany({ where: { workspaceId: viewerWorkspaceId, trackingStatus: "ACTIVE", isDemo: false }, orderBy: { fullName: "asc" }, select: { id: true, githubId: true, fullName: true } });
    tracked = rows.map((r) => ({ id: r.id, githubId: r.githubId.toString(), fullName: r.fullName }));
    covered = await readCoverage(db, overview.webhooks.appSlug);
  } catch {
    // keep the empty lists
  }
  return <InstantUpdatesPanel teamName={overview.teamName} origin={origin} isOwner={overview.me.role === "OWNER"} webhooks={overview.webhooks} tracked={tracked} covered={covered} appResult={githubApp} />;
}

/** The Team page of a hub profile. Loads what the hub says; a failure is shown in the page, never thrown. Only hub services are touched. */
export async function HubTeamPage({ backend, githubApp }: { backend: string; githubApp?: GithubAppResult | null }) {
  const { viewer } = await requireViewer();
  const { svc, dbFile, origin } = await getHubTeamService(backend);
  const status: HubLinkStatus = await hubLinkStatus(dbFile).catch(() => ({ state: "offline", pendingOps: 0, needsSignIn: false }));
  let overview: HubOverview | null = null;
  let error: HubTeamError | null = null;
  try {
    overview = await svc.overview();
  } catch (e) {
    error = e instanceof HubUnauthorized ? { kind: "unauthorized" } : e instanceof HubForbidden ? { kind: "forbidden" } : { kind: "request", message: e instanceof Error && e.name === "HubRequestError" ? e.message : "The server did not answer. What is shown may be out of date." };
  }
  // Members of each space are an admin-only extra; if it fails the page keeps the name-only list.
  let spaceMembers: HubAdminSpace[] | null = null;
  if (overview?.canAdmin) spaceMembers = await svc.adminSpaces().catch(() => null);
  const removedMembers = overview ? await svc.removedMembers().catch(() => []) : [];
  const instantUpdates = overview && !error ? await instantUpdatesPanel({ overview, origin, viewerWorkspaceId: viewer.workspaceId, githubApp }) : null;
  return <HubTeamPanel origin={origin} status={status} overview={overview} error={error} spaceMembers={spaceMembers} removedMembers={removedMembers} instantUpdates={instantUpdates} />;
}
