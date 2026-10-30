import type { ReactNode } from "react";
import Link from "next/link";
import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Sheet } from "@/components/ui/dialog";
import { Avatar, Banner, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Lock, ShieldCheck, Trash2, Users } from "@/components/ui/icons";
import { hubChangeRoleAction, hubCreateSpaceAction, hubDeleteSpaceAction, hubInviteAction, hubReinstateMemberAction, hubRemoveMemberAction, hubSignOutAction } from "@/app/hub-team-actions";
import { HubSignOut } from "@/components/team/HubSignOut";
import type { HubAdminSpace, HubLinkStatus, HubMember, HubSpaceMember } from "@/lib/hub/ports";
import type { HubOverview } from "@/lib/team/hub-service";

export const DELETE_SPACE_WARNING = "Deleting this space removes its projects, cards and tasks from every member's computer.";

export type HubTeamError = { kind: "unauthorized" } | { kind: "forbidden" } | { kind: "request"; message: string };

const LINK: Record<HubLinkStatus["state"], { label: string; tone: "ok" | "waiting" | "unknown" }> = {
  live: { label: "Live", tone: "ok" },
  reconnecting: { label: "Reconnecting", tone: "waiting" },
  offline: { label: "Offline", tone: "unknown" },
};
const ROLE_LABEL: Record<HubMember["role"], string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", READER: "Reader" };

export function ConnectionPill({ status }: { status: HubLinkStatus }) {
  const l = LINK[status.state];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <SimplePill tone={l.tone}>{l.label}</SimplePill>
      {status.pendingOps > 0 && <span className="text-[12.5px] text-ink-3">{status.pendingOps} pending</span>}
    </span>
  );
}

function SpaceMembers({ members, people }: { members?: HubSpaceMember[]; people: HubMember[] }) {
  if (!members) return null;
  if (members.length === 0) return <p className="mt-1 text-[12.5px] text-ink-3">No members yet.</p>;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Members of this space">
      {members.map((m) => (
        <li key={m.githubId} className="inline-flex items-center gap-1.5 text-[12.5px]">
          @{people.find((p) => p.githubId === m.githubId)?.login ?? `user ${m.githubId}`}
          <SimplePill tone={m.canWrite ? "ok" : "unknown"}>{m.canWrite ? "Can edit" : "Read only"}</SimplePill>
        </li>
      ))}
    </ul>
  );
}

const hubHost = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const ROLE_OPTIONS = (
  <>
    <option value="ADMIN">Admin</option>
    <option value="MEMBER">Member</option>
    <option value="READER">Reader</option>
  </>
);

/** Presentational: everything it shows was already decided by the page. Writes go through server actions, which the hub re-checks. */
export function HubTeamPanel({ origin, status, overview, error, spaceMembers = null, removedMembers = [], instantUpdates = null }: { origin: string | null; status: HubLinkStatus; overview: HubOverview | null; error: HubTeamError | null; spaceMembers?: HubAdminSpace[] | null; removedMembers?: HubMember[]; instantUpdates?: ReactNode }) {
  const removed = error?.kind === "forbidden";
  const needsSignIn = (status.needsSignIn || error?.kind === "unauthorized") && !removed;
  const o = removed ? null : overview;
  const members = o?.members.filter((m) => m.status !== "REMOVED") ?? [];
  const restricted = o?.spaces.filter((s) => s.kind === "RESTRICTED") ?? [];
  return (
    <>
      <PageHeader
        title={o?.teamName ?? "Team"}
        subtitle={origin ? <>Hosted on <Mono>{hubHost(origin)}</Mono>. Planning data is shared through this server.</> : "Planning data is shared through a team server."}
        actions={<ConnectionPill status={status} />}
      />
      {removed && <div className="mb-5"><Banner tone="error" title="You were removed from this team.">Ask the owner of the server to reinstate you, or sign out to go back to GitHub.</Banner></div>}
      {needsSignIn && (
        <div className="mb-5">
          <Banner tone="warn" title="Sign in to the server again" action={<Link href="/sign-in?connect=1" className="btn btn-primary !h-10 shrink-0 self-center">Sign in to the server again</Link>}>
            Your session on this server ended. Changes made here are kept and will be sent after you sign in.
          </Banner>
        </div>
      )}
      {error?.kind === "request" && <div className="mb-5"><Banner tone="error" title="Could not load the team from the server">{error.message}</Banner></div>}

      {o && (
        <div className="flex flex-col gap-5">
          {instantUpdates}
          <Panel title={`Members (${members.length})`} icon={Users} id="members">
            <ul>
              {members.map((m) => {
                const self = m.githubId === o.me.githubId;
                const editable = o.canAdmin && !self && m.role !== "OWNER";
                return (
                  <li key={m.githubId} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                    <div className="flex min-w-0 items-center gap-3">
                      <Avatar login={m.login} url={m.avatarUrl} size={28} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{m.name ?? `@${m.login}`}{self && <span className="ml-1 text-ink-3">(you)</span>}</p>
                        <p className="truncate text-[12.5px] text-ink-3">@{m.login}</p>
                      </div>
                      <SimplePill tone={m.status === "INVITED" ? "waiting" : "needs"}>{m.status === "INVITED" ? "Invited" : ROLE_LABEL[m.role]}</SimplePill>
                    </div>
                    {editable && (
                      <div className="flex flex-wrap items-start gap-2">
                        <ActionForm action={hubChangeRoleAction} submitLabel="Save role" pendingLabel="Saving…" submitClassName="btn !h-10" resetOnSuccess={false} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="githubId" value={m.githubId} />
                          <Select name="role" aria-label={`Role for @${m.login}`} defaultValue={m.role} className="select !h-10 !w-32">{ROLE_OPTIONS}</Select>
                        </ActionForm>
                        <ActionForm action={hubRemoveMemberAction} submitLabel="Remove" pendingLabel="Removing…" submitClassName="btn btn-danger !h-10" submitAriaLabel={`Remove @${m.login}`}>
                          <input type="hidden" name="githubId" value={m.githubId} />
                        </ActionForm>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {removedMembers.length > 0 && (
              <div className="border-t border-line p-4">
                <p className="mb-2 text-[12.5px] text-ink-3">Removed people can be reinstated by the owner. They return to the common space only; restricted spaces are granted again on purpose.</p>
                <ul>
                  {removedMembers.map((m) => (
                    <li key={m.githubId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                      <span className="truncate">@{m.login} <span className="text-ink-3">(removed)</span></span>
                      <ActionForm action={hubReinstateMemberAction} submitLabel="Reinstate" pendingLabel="Reinstating…" submitClassName="btn !h-10" submitAriaLabel={`Reinstate @${m.login}`} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="githubId" value={m.githubId} />
                        <Select name="role" aria-label={`Role for @${m.login} when reinstated`} defaultValue="MEMBER" className="select !h-10 !w-32">{ROLE_OPTIONS}</Select>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {o.canAdmin && (
              <div className="border-t border-line p-4">
                <ActionForm action={hubInviteAction} submitLabel="Invite" pendingLabel="Inviting…" submitClassName="btn btn-primary !h-10" className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1"><label className="label" htmlFor="hub-invite-login">GitHub username</label><input id="hub-invite-login" name="login" className="input !h-10 !w-full sm:!w-56" placeholder="alice" autoComplete="off" required /></div>
                  <div><label className="label" htmlFor="hub-invite-role">Role</label><Select id="hub-invite-role" name="role" defaultValue="MEMBER" className="select !h-10 !w-32">{ROLE_OPTIONS}</Select></div>
                </ActionForm>
              </div>
            )}
          </Panel>

          <Panel title={`Restricted spaces (${restricted.length})`} icon={ShieldCheck} id="spaces">
            {restricted.length === 0 ? (
              <EmptyState icon={Lock} title="No restricted spaces">Everyone on the team shares the common space. A restricted space is visible only to the people you pick.</EmptyState>
            ) : (
              <ul>
                {restricted.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                    <div className="min-w-0">
                    <p className="flex min-w-0 flex-wrap items-center gap-2 font-medium"><span className="truncate">{s.name}</span><SimplePill tone="waiting">Restricted audience</SimplePill><span className="text-[12.5px] font-normal text-ink-3">your access: {s.canWrite ? "write" : "read"}</span></p>
                    <SpaceMembers members={spaceMembers?.find((x) => x.id === s.id)?.members} people={o.members} />
                    </div>
                    {o.canAdmin && (
                      <Sheet title={`Delete “${s.name}”?`} description={DELETE_SPACE_WARNING} trigger={<button type="button" className="btn btn-danger !h-10"><Trash2 size={14} aria-hidden />Delete space</button>}>
                        <ActionForm action={hubDeleteSpaceAction} submitLabel="Delete space" pendingLabel="Deleting…" submitClassName="btn btn-danger !h-10">
                          <input type="hidden" name="spaceId" value={s.id} />
                          <input type="hidden" name="confirm" value="on" />
                        </ActionForm>
                      </Sheet>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {o.canAdmin && (
              <div className="border-t border-line p-4">
                <p className="mb-2 text-[12.5px] font-medium">New restricted space</p>
                <ActionForm action={hubCreateSpaceAction} submitLabel="Create space" pendingLabel="Creating…" submitClassName="btn btn-primary !h-10">
                  <label className="label" htmlFor="hub-space-name">Space name</label>
                  <input id="hub-space-name" name="name" className="input !h-10 !w-full sm:!w-64" required />
                  <fieldset className="mt-3">
                    <legend className="label">Who can see it</legend>
                    <ul className="flex flex-col">
                      {members.filter((m) => m.status === "ACTIVE").map((m) => (
                        <li key={m.githubId} className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
                          <label className="flex items-center gap-2"><input type="checkbox" name="member" value={m.githubId} defaultChecked={m.githubId === o.me.githubId} /> @{m.login}</label>
                          <label className="flex items-center gap-2 text-ink-3"><input type="checkbox" name="write" value={m.githubId} defaultChecked /> can edit</label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                </ActionForm>
              </div>
            )}
          </Panel>
        </div>
      )}

      <div className="mt-5"><HubSignOut action={hubSignOutAction} /></div>
    </>
  );
}
