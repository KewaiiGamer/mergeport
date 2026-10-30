import { Select } from "@/components/ui/Select";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { getEngine, getTeamService } from "@/lib/local/runtime";
import { KEY_CANDIDATES, KEY_INVITATIONS, cached, keyInvitationStatus, refreshing, teamWithDeadline } from "@/lib/local/discovery-jobs";
import { Freshness } from "@/components/sync/Freshness";
import { CandidateCard } from "@/components/team/CandidateCard";
import { expectedConsistencyDelaySeconds } from "@/lib/sync/engine";
import { SOURCE_ACCESS_NOTE, type InvitationStatus, type TeamPlan } from "@/lib/team/service";
import { GithubError as GhErr } from "@/lib/github/port";
import { formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { CopyField } from "@/components/forms/CopyField";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill, Time } from "@/components/ui/primitives";
import { Link, Lock, Mail, ShieldCheck, Users } from "@/components/ui/icons";
import { SyncBadge } from "@/components/sync/SyncBadge";
import { leaveTeamAction, acceptGithubInvitationAction, createSpaceAction, createTeamAction, inviteAction, revokeAccessAction } from "@/app/team-actions";
import { env } from "@/lib/env";
import { isHubBackend } from "@/lib/local/backends";
import { currentBackend } from "@/lib/local/workspaces";
import { HubTeamPage } from "@/components/team/HubTeamPage";

export const metadata = { title: "Team" };
export const dynamic = "force-dynamic";

type SP = { name?: string; owner?: string; invite?: string; users?: string; perm?: string; "github-app"?: string; reason?: string };

export default async function TeamPage({ searchParams }: { searchParams: Promise<SP> }) {
  const { viewer } = await requireViewer();
  const backend = await currentBackend();
  const sp = await searchParams;
  if (isHubBackend(backend)) {
    // `?github-app=created` or `?github-app=failed&reason=<code>`: where the GitHub App callback sends the owner back.
    const result = sp["github-app"] === "created" || sp["github-app"] === "failed" ? sp["github-app"] : null;
    return <HubTeamPage backend={backend} githubApp={result ? { result, reason: sp.reason } : null} />;
  }
  const demo = isDemo();
  const cfg = await db.teamConfig.findUnique({ where: { id: "team" } });
  const spaces = await db.space.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "asc" }] });
  const team = await getTeamService();
  const engine = await getEngine();

  let plan: TeamPlan | null = null;
  let planError: string | null = null;
  if (team && sp.name && cfg?.mode !== "TEAM") {
    // The ONLY live GitHub call while rendering, and only because the person just asked for a plan. It has a hard deadline.
    try {
      plan = await (await teamWithDeadline(12_000)).planTeam({ name: sp.name, owner: sp.owner || undefined });
    } catch (e) {
      planError = e instanceof GhErr && e.kind === "network" ? "GitHub did not answer. Check your connection and review the plan again." : e instanceof Error ? e.message : "Could not prepare the plan";
    }
  }
  // Everything below comes from the local cache: no GitHub call, no waiting. Each list says how old it is and why.
  const invView = !demo && team ? await cached.invitations() : null;
  const invitations = invView?.payload ?? [];
  const candView = !demo && team ? await cached.candidates() : null;
  const candidates = candView?.payload ?? [];
  const states = engine ? new Map(await Promise.all(spaces.map(async (s) => [s.id, await engine.stateFor(s)] as const))) : new Map();
  const delay = expectedConsistencyDelaySeconds(cfg?.pollSeconds ?? 30);

  const invitePlanSpace = sp.invite ? spaces.find((s) => s.id === sp.invite) : undefined;
  const invitePlan = team && invitePlanSpace && sp.users ? (() => { try { return team.planInvite(invitePlanSpace, sp.users!.split(/[,\s]+/), sp.perm === "pull" ? "pull" : "push"); } catch { return null; } })() : null;
  const statusBySpace = new Map<string, Awaited<ReturnType<typeof cached.invitationStatus>>>();
  if (team) for (const sp2 of spaces.filter((x) => x.canAdmin && x.access === "OK")) statusBySpace.set(sp2.id, await cached.invitationStatus(sp2.id));

  return (
    <>
      <PageHeader title="Team" subtitle="Mergeport runs on your computer. A team shares Mergeport-owned planning data through private GitHub repositories. Nobody hosts a server." />
      {demo && <div className="mb-4"><Banner title="Demo mode">Teams need your real GitHub account. Run <span className="mono">npm run local</span> to create or join one.</Banner></div>}

      <div className="mb-5">
        <Banner title={cfg?.mode === "TEAM" ? `Team mode: ${cfg.name}` : "Personal mode"}>
          {cfg?.mode === "TEAM"
            ? `Shared data is eventually consistent: a teammate's change reaches you within about ${delay.typical} seconds while both apps are open and polling (up to ${Math.round(delay.worst / 60)} minutes when idle). If GitHub is unreachable or rate-limited, edits queue on this computer. Background sync runs only while this app runs; shared data stays in GitHub when everyone is offline.`
            : "Your configuration and cache stay on this computer. Create a team to share planning with teammates, or join one you were invited to."}
        </Banner>
      </div>

      {cfg?.mode !== "TEAM" && !demo && (
        <div className="mb-5 grid gap-5 lg:grid-cols-2">
          <Panel title="Create a team" icon={Users} id="create">
            <div className="flex flex-col gap-4 p-4 text-[13px]">
              <form method="get" className="flex flex-wrap items-end gap-3">
                <div><label className="label" htmlFor="t-name">Team name</label><input id="t-name" name="name" defaultValue={sp.name} className="input !w-56" required /></div>
                <div><label className="label" htmlFor="t-owner">Owner (you, or an organization you can create repositories in)</label><input id="t-owner" name="owner" defaultValue={sp.owner ?? viewer.login} className="input !w-56" /></div>
                <button className="btn">Review plan</button>
              </form>
              {planError && <Banner tone="error" title="Cannot plan this team">{planError}</Banner>}
              {plan && (
                <ActionForm action={createTeamAction} submitLabel="Create private repository" pendingLabel="Creating…" resetOnSuccess={false}>
                  <input type="hidden" name="name" value={plan.teamName} /><input type="hidden" name="owner" value={plan.owner} /><input type="hidden" name="expected" value={plan.fullName} />
                  <div className="rounded-[10px] border border-line bg-canvas p-3">
                    <p className="font-medium">Will create <Mono>{plan.fullName}</Mono></p>
                    <dl className="mt-2 grid grid-cols-[100px_1fr] gap-y-1 text-[12.5px]"><dt className="text-ink-3">Owner</dt><dd>{plan.owner} ({plan.ownerType === "personal" ? "personal account" : "organization"})</dd><dt className="text-ink-3">Visibility</dt><dd className="inline-flex items-center gap-1"><Lock size={12} aria-hidden /> private</dd><dt className="text-ink-3">Purpose</dt><dd>{plan.purpose}</dd></dl>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] text-ink-2">{plan.permissions.map((p) => <li key={p}>{p}</li>)}</ul>
                    {plan.renamedBecauseOfCollision && <p className="mt-2 text-[12.5px] text-waiting">A repository with the usual name already exists, so a numbered name is proposed. The existing repository is not touched.</p>}
                  </div>
                  <label className="mt-3 flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-1" /> <span>I confirm: create this private repository on my GitHub account and make me its administrator.</span></label>
                </ActionForm>
              )}
            </div>
          </Panel>
          <Panel title="Join a team" icon={Mail} id="join">
            <div className="flex flex-col gap-4 p-4 text-[13px]">
              {invView && <Freshness view={invView} listKey={KEY_INVITATIONS} timezone={viewer.timezone} refreshing={refreshing(KEY_INVITATIONS)} />}
              {invitations.length > 0 && (
                <ul className="flex flex-col gap-2">
                  {invitations.map((i) => (
                    <li key={i.id} className="rounded-[10px] border border-line p-3">
                      <p className="font-medium"><Mono>{i.fullName}</Mono></p>
                      <p className="text-[12.5px] text-ink-3">Invited by @{i.inviter} with {i.permission} access. Accepting gives you access to that repository only.</p>
                      <ActionForm action={acceptGithubInvitationAction} submitLabel="Accept on GitHub" submitClassName="btn mt-2"><input type="hidden" name="id" value={i.id} /></ActionForm>
                    </li>
                  ))}
                </ul>
              )}
              {candView && <Freshness view={candView} listKey={KEY_CANDIDATES} timezone={viewer.timezone} refreshing={refreshing(KEY_CANDIDATES)} />}
              {candidates.length > 0 && (
                <div className="flex flex-col gap-2">
                  <p className="text-ink-3">Private team repositories your GitHub account can already read. <strong className="font-medium text-ink-2">Nothing is joined until you review and confirm.</strong></p>
                  <ul className="flex flex-col gap-2">{candidates.map((c) => <CandidateCard key={c.fullName} c={c} />)}</ul>
                </div>
              )}
              <form method="get" action="/join" className="flex flex-wrap items-end gap-2">
                <div><label className="label" htmlFor="j-repo">Join link or repository (owner/repo)</label><input id="j-repo" name="repo" className="input !w-72" required placeholder="owner/mergeport-team-workspace" /></div>
                <button className="btn">Review before joining</button>
              </form>
              <p className="text-[12px] text-ink-3">A join link only names a repository. Access comes from the GitHub invitation you accepted. You will see what the repository is, what joining downloads and publishes, and join only after you confirm.</p>
            </div>
          </Panel>
        </div>
      )}

      {team && (
        <details className="mb-5 rounded-[10px] border border-line p-3 text-[13px]">
          <summary className="cursor-pointer font-medium">Stop using this team on this computer</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-ink-3">Forgets the team and its spaces here, makes shared repositories and projects local again, and returns to personal mode so you can create or join a different team. Your boards, cards and rules stay. Nothing is changed on GitHub: the team repositories, invitations and collaborators remain until you remove them there.</p>
            <ActionForm action={leaveTeamAction} submitLabel="Stop using this team" submitClassName="btn btn-danger" resetOnSuccess={false}>
              <label className="flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-0.5" /> I understand this computer will stop syncing with this team.</label>
            </ActionForm>
          </div>
        </details>
      )}
      <Panel title={`Spaces (${spaces.length})`} icon={ShieldCheck} id="spaces">
        {spaces.length === 0 ? <EmptyState icon={ShieldCheck} title="No spaces yet">A space is one private GitHub repository with one audience. Create a team or join one to get your first space.</EmptyState> : (
          <ul>
            {spaces.map((s) => {
              const st = states.get(s.id);
              const statuses = statusBySpace.get(s.id);
              return (
                <li key={s.id} className="flex flex-col gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium"><Mono title={`${s.repoOwner}/${s.repoName}`}>{s.repoOwner}/{s.repoName}</Mono><SimplePill tone={s.kind === "COMMON" ? "needs" : "waiting"}>{s.kind === "COMMON" ? "Common: everyone on the team" : "Restricted audience"}</SimplePill></p>
                      <p className="mt-0.5 text-[12.5px] text-ink-3">{s.name} · your GitHub permission: <strong className="font-medium text-ink-2">{s.canAdmin ? "admin" : s.canWrite ? "write" : "read"}</strong>{s.lastPolledAt && <> · checked <Time value={s.lastPolledAt} formatted={formatInstant(s.lastPolledAt, viewer.timezone)} /></>}</p>
                    </div>
                    {st && <SyncBadge state={st.state} pending={st.pending} conflicts={st.conflicts} detail={st.detail} />}
                  </div>
                  {s.access !== "OK" && <Banner tone="error" title={s.access === "REVOKED" ? "Access revoked" : s.access === "SCHEMA_NEWER" ? "Newer Mergeport required" : "Not usable as a space"}>{s.lastError}</Banner>}
                  {s.canAdmin && s.access === "OK" && (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <p className="mb-1 text-[12.5px] font-medium">Invite people to this space</p>
                        <form method="get" className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="invite" value={s.id} />
                          <div><label className="label" htmlFor={`iu-${s.id}`}>GitHub usernames</label><input id={`iu-${s.id}`} name="users" defaultValue={sp.invite === s.id ? sp.users : ""} className="input !w-52" placeholder="alice, bram" /></div>
                          <div><label className="label" htmlFor={`ip-${s.id}`}>Access</label><Select id={`ip-${s.id}`} name="perm" defaultValue={sp.perm ?? "push"} className="select !w-28"><option value="push">Write</option><option value="pull">Read</option></Select></div>
                          <button className="btn">Review invitation</button>
                        </form>
                        {invitePlan && invitePlanSpace?.id === s.id && (
                          <ActionForm action={inviteAction} submitLabel="Send invitations" pendingLabel="Sending…" className="mt-3" resetOnSuccess={false}>
                            <input type="hidden" name="spaceId" value={s.id} /><input type="hidden" name="usernames" value={invitePlan.usernames.join(",")} /><input type="hidden" name="permission" value={invitePlan.permission} />
                            <div className="rounded-[10px] border border-line bg-canvas p-3 text-[12.5px]">
                              <p className="font-medium">Invite {invitePlan.usernames.map((u) => `@${u}`).join(", ")} to <Mono>{invitePlan.fullName}</Mono></p>
                              <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-2">{invitePlan.explanation.map((x) => <li key={x}>{x}</li>)}</ul>
                              <p className="mt-2 text-waiting">{SOURCE_ACCESS_NOTE}</p>
                            </div>
                            <label className="mt-2 flex items-start gap-2 text-[13px]"><input type="checkbox" name="confirm" required className="mt-1" /> <span>Send these GitHub invitations now.</span></label>
                          </ActionForm>
                        )}
                        <div className="mt-3"><CopyField absolute label="Join link (names the space; not a credential)" value={`/join?repo=${encodeURIComponent(`${s.repoOwner}/${s.repoName}`)}`} hint={`Send it with the GitHub invitation. Port ${env().MERGEPORT_PORT} is this computer's; teammates use their own.`} /></div>
                      </div>
                      <div>
                        <p className="mb-1 text-[12.5px] font-medium">Invitations and access (from GitHub)</p>
                        {statuses && <div className="mb-2"><Freshness view={statuses} listKey={keyInvitationStatus(s.id)} timezone={viewer.timezone} refreshing={refreshing(keyInvitationStatus(s.id))} /></div>}
                        {!statuses?.payload || statuses.payload.length === 0 ? <p className="text-[12.5px] text-ink-3">{statuses?.state === "EMPTY" ? "Not checked yet." : statuses?.fetchedAt ? "Nobody else has been invited." : "No saved list yet."}</p> : (
                          <ul className="flex flex-col gap-1.5 text-[13px]">
                            {statuses.payload.map((i: InvitationStatus) => (
                              <li key={i.username} className="flex items-center justify-between gap-2">
                                <span>@{i.username} <SimplePill tone={i.state === "accepted" ? "ok" : i.state === "pending" ? "waiting" : "blocked"}>{i.state}</SimplePill></span>
                                <ActionForm action={revokeAccessAction} submitLabel={i.state === "accepted" ? "Remove access" : "Cancel"} submitClassName="btn btn-danger !h-7"><input type="hidden" name="spaceId" value={s.id} /><input type="hidden" name="username" value={i.username} /></ActionForm>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {cfg?.mode === "TEAM" && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Panel title="Spaces you can join" icon={Link} id="discover">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              <p className="text-ink-3">Restricted spaces are never listed in the common repository. Mergeport lists private repositories YOUR GitHub account can already read that look like spaces of this team, and tells you what each one is. <strong className="font-medium text-ink-2">Nothing is joined automatically.</strong></p>
              {candView && <Freshness view={candView} listKey={KEY_CANDIDATES} timezone={viewer.timezone} refreshing={refreshing(KEY_CANDIDATES)} />}
              {candidates.length === 0 ? <p className="text-[12.5px] text-ink-3">{candView?.fetchedAt ? "No other spaces are visible to your GitHub account." : "No saved list yet."}</p> : <ul className="flex flex-col gap-2">{candidates.map((c) => <CandidateCard key={c.fullName} c={c} />)}</ul>}
              {invitations.length > 0 && <ul className="flex flex-col gap-2">{invitations.map((i) => <li key={i.id} className="rounded-[10px] border border-line p-3"><Mono>{i.fullName}</Mono> <span className="text-ink-3">invited by @{i.inviter}</span><ActionForm action={acceptGithubInvitationAction} submitLabel="Accept on GitHub" submitClassName="btn mt-2"><input type="hidden" name="id" value={i.id} /></ActionForm></li>)}</ul>}
            </div>
          </Panel>
          {spaces.some((s) => s.canAdmin && s.kind === "COMMON") && (
            <Panel title="New restricted space" icon={Lock} id="restricted">
              <div className="p-4 text-[13px]">
                <p className="mb-3 text-ink-3">Restricted projects need their own private repository whose collaborators are exactly the people allowed to see them. Everyone who can read a repository can read all of its files and history, so audiences are separated by repository, not by folder.</p>
                <ActionForm action={createSpaceAction} submitLabel="Create private repository" pendingLabel="Creating…">
                  <label className="label" htmlFor="rs-name">Space name</label><input id="rs-name" name="name" className="input" required />
                  <label className="mt-3 flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-1" /> <span>Create a new private GitHub repository for this audience. I will invite its members separately.</span></label>
                </ActionForm>
              </div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}
