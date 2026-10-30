import { Select } from "@/components/ui/Select";
import { describeAccess, type RepoPermissions } from "@/lib/domain/repo-access";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { listRepositories } from "@/lib/services/queries";
import { repoWhere } from "@/lib/authz/viewer";
import { formatDuration } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Avatar, Banner, DemoBadge, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Building2, FolderGit2, GitFork, Globe, Lock, Plus, RefreshCw, Unplug, User, Users, Zap } from "@/components/ui/icons";
import { instantRepoIds } from "@/lib/hub/instant-badges";
import { importPublicAction, refreshRepositoryAction, untrackRepositoryAction } from "@/app/actions";
import { shareRepositoryAction, unshareRepositoryAction } from "@/app/team-actions";

export const metadata = { title: "Repositories" };

export default async function Repositories({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const { viewer } = await requireViewer();
  const showAll = (await searchParams).all === "1";
  const now = new Date();
  const [repos, spaces] = await Promise.all([listRepositories(db, viewer), db.space.findMany({ where: { access: "OK" }, orderBy: [{ kind: "asc" }, { name: "asc" }] })]);
  // Repositories the team's GitHub App covers (last result of "Add my tracked repositories"; local data, no GitHub request).
  const instant = await instantRepoIds(db);
  const spaceById = new Map(spaces.map((s) => [s.id, s]));
  const writable = spaces.filter((s) => s.canWrite);
  // A fork's parent name is shown only if that parent is not a tracked repository hidden from this viewer.
  const parentIds = repos.map((r) => r.parentGithubId).filter((x): x is bigint => x !== null);
  const [trackedParents, visibleParents] = await Promise.all([
    db.repository.findMany({ where: { workspaceId: viewer.workspaceId, githubId: { in: parentIds } }, select: { githubId: true } }),
    db.repository.findMany({ where: { AND: [repoWhere(viewer), { githubId: { in: parentIds } }] }, select: { githubId: true } }),
  ]);
  const hiddenParents = new Set(trackedParents.map((p) => p.githubId.toString()));
  for (const v of visibleParents) hiddenParents.delete(v.githubId.toString());
  const problems = repos.filter((r) => r.trackingStatus === "DISCONNECTED" || r.rateLimited || r.syncError);

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="Repositories tracked on this computer, plus any a teammate shared with you. Tracking is private to you until you share a repository to a space."
        actions={<Link href="/repositories/connect" className="btn btn-primary"><Plus size={14} aria-hidden /> Connect repositories</Link>}
      />

      {problems.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {problems.map((r) => (
            <Banner key={r.id} tone={r.trackingStatus === "DISCONNECTED" ? "error" : "warn"} title={`${r.fullName}: ${r.trackingStatus === "DISCONNECTED" ? "disconnected" : r.rateLimited ? "GitHub rate limit reached" : "last sync failed"}`}>
              {(r.statusDetail ?? r.syncError) ? `${r.statusDetail ?? r.syncError}. ` : ""}Data shown is the last successful sync, not current GitHub state.
            </Banner>
          ))}
        </div>
      )}

      <Panel title={`Tracked repositories (${repos.length})`} icon={FolderGit2} id="repos"
        actions={
          <ActionForm action={importPublicAction} submitLabel="Track" pendingLabel="Checking…" className="flex w-full items-start gap-2 sm:w-auto" submitClassName="btn btn-primary">
            <label className="sr-only" htmlFor="pub-url">Public repository URL or owner/repo</label>
            <input id="pub-url" name="repo" className="input !w-full sm:!w-64" placeholder="Public URL or owner/repo" required />
          </ActionForm>
        }>
        {repos.length === 0 ? (
          <EmptyState icon={FolderGit2} title="No repositories yet" action={<Link href="/repositories/connect" className="btn btn-primary">Connect repositories</Link>}>
            Import a public repository by URL, or choose from repositories your GitHub account can access.
          </EmptyState>
        ) : (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Repositories (scrolls horizontally on narrow screens)">
            <table className="data min-w-[980px]">
              <thead><tr><th scope="col">Repository</th><th scope="col">Account</th><th scope="col">Access</th><th scope="col">Status</th><th scope="col">Sharing</th><th scope="col">Projects</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {(showAll ? repos : repos.slice(0, 30)).map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="flex items-center gap-2"><span className="font-medium [overflow-wrap:anywhere]">{r.name}</span>{r.archived && <SimplePill tone="unknown">Archived</SimplePill>}{r.isDemo && <DemoBadge />}{instant.has(r.githubId.toString()) && <SimplePill tone="ok" icon={Zap}>Instant</SimplePill>}</div>
                      <p className="mt-0.5 text-[12px] text-ink-3">{r.isFork ? <span className="inline-flex items-center gap-1"><GitFork size={12} aria-hidden />fork of {r.parentGithubId !== null && hiddenParents.has(r.parentGithubId.toString()) ? <span>an upstream not shared with you</span> : <Mono>{r.parentFullName ?? "unknown"}</Mono>} · </span> : null}default branch <Mono>{r.defaultBranch ?? "unknown"}</Mono></p>
                      <p className="mt-0.5 text-[12px] text-ink-3">{r.lastSyncedAt ? `${r._count.workItems} open item${r._count.workItems === 1 ? "" : "s"}` : "Open items unknown until the first sync"}</p>
                    </td>
                    <td>
                      <div className="flex items-center gap-2"><Avatar login={r.owner.login} url={r.owner.avatarUrl} size={20} /><span>{r.owner.login}</span></div>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-ink-3" title="From GitHub owner metadata, not from the name">{r.owner.type === "ORGANIZATION" ? <Building2 size={12} aria-hidden /> : <User size={12} aria-hidden />}{r.owner.type === "ORGANIZATION" ? "Organization" : r.owner.type === "USER" ? "Personal account" : "Account type unknown"}{r.owner.synthetic ? " (synthetic)" : ""}</p>
                    </td>
                    <td><span className="inline-flex items-center gap-1 text-[12.5px]">{r.visibility === "PUBLIC" ? <Globe size={13} aria-hidden /> : <Lock size={13} aria-hidden />}{r.visibility.toLowerCase()}</span><p className="mt-0.5 text-[12px] text-ink-3" title={describeAccess(r.permissions as RepoPermissions).detail}>{describeAccess(r.permissions as RepoPermissions).label}</p></td>
                    <td>
                      {r.trackingStatus === "DISCONNECTED" ? <SimplePill tone="blocked" icon={Unplug}>Disconnected</SimplePill> : r.rateLimited ? <SimplePill tone="waiting">Rate limited</SimplePill> : r.syncError ? <SimplePill tone="changes">Sync failed</SimplePill> : <SimplePill tone="ok">Active</SimplePill>}
                      <p className="mt-1 text-[11.5px] text-ink-3">{r.lastSyncedAt ? `Last successful sync ${formatDuration(now.getTime() - r.lastSyncedAt.getTime())} ago` : "Never synchronized"}</p>
                    </td>
                    <td className="text-[12.5px]">
                      {r.spaceId ? (
                        <>
                          <SimplePill tone="needs" icon={Users}>Shared</SimplePill>
                          <p className="mt-1 text-ink-3">{spaceById.get(r.spaceId)?.name ?? "a space"}</p>
                          {spaceById.get(r.spaceId)?.canWrite && <ActionForm action={unshareRepositoryAction} submitLabel="Stop sharing" submitClassName="btn mt-1.5" resetOnSuccess={false}><input type="hidden" name="repositoryId" value={r.id} /></ActionForm>}
                        </>
                      ) : writable.length > 0 ? (
                        <ActionForm action={shareRepositoryAction} submitLabel="Share" pendingLabel="Sharing…" resetOnSuccess={false} className="flex flex-col gap-1.5">
                          <input type="hidden" name="repositoryId" value={r.id} />
                          <label className="sr-only" htmlFor={`sp-${r.id}`}>Space to share {r.name} with</label>
                          <Select id={`sp-${r.id}`} name="spaceId" className="select !h-8 !text-[12.5px]">{writable.map((s) => <option key={s.id} value={s.id}>{s.name}{s.kind === "COMMON" ? " (everyone)" : ""}</option>)}</Select>
                          <label className="flex items-start gap-1.5 text-[11.5px] text-ink-3"><input type="checkbox" name="confirm" className="mt-0.5" required /> Everyone with access to that space can see this repository&apos;s name and planning data.</label>
                        </ActionForm>
                      ) : <span className="text-ink-3">Only on this computer</span>}
                    </td>
                    <td className="text-[12.5px]">{r.projects.length ? r.projects.map((p) => p.project.name).join(", ") : <span className="text-ink-3">None</span>}</td>
                    <td>
                      <div className="flex flex-col gap-1.5">
                        <Link href={`/repositories/${r.id}/code`} className="btn" aria-label={`Browse code of ${r.fullName}`}>Browse code</Link>
                        <ActionForm action={refreshRepositoryAction} submitLabel="Refresh" submitAriaLabel={`Refresh ${r.fullName}`} submitClassName="btn"><input type="hidden" name="repositoryId" value={r.id} /></ActionForm>
                        <ActionForm action={untrackRepositoryAction} submitLabel="Stop tracking" submitAriaLabel={`Stop tracking ${r.fullName}`} submitClassName="btn btn-danger"><input type="hidden" name="repositoryId" value={r.id} /></ActionForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {repos.length > 30 && <p className="border-t border-line px-4 py-3 text-[13px] text-ink-3">{showAll ? <>Showing all {repos.length}. <Link className="underline" href="/repositories">Show fewer</Link></> : <>Showing 30 of {repos.length}. <Link className="underline" href="/repositories?all=1">Show all</Link></>}</p>}
      </Panel>
      <p className="mt-3 flex items-center gap-1.5 text-[12px] text-ink-3"><RefreshCw size={12} aria-hidden /> Stopping tracking removes it from the dashboard only. Nothing is deleted on GitHub.</p>
    </>
  );
}
