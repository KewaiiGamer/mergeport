import Link from "next/link";
import { RepoChecklist } from "@/components/forms/RepoChecklist";
import { Select } from "@/components/ui/Select";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Layers, Plus } from "@/components/ui/icons";
import { createProjectAction, setProjectMembersAction, setProjectReposAction, setProjectReviewersAction } from "@/app/actions";
import { byOwnerFirst, byPersonalFirst } from "@/lib/domain/ordering";
import { projectReviewerRefs } from "@/lib/services/project-reviewers";
import { setProjectSpaceAction } from "@/app/team-actions";

export const metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function Projects() {
  const { viewer } = await requireAdminViewer();
  const spaces = await db.space.findMany({ where: { access: "OK", canWrite: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  const [projectsRaw, reposRaw, members] = await Promise.all([
    db.project.findMany({ where: { workspaceId: viewer.workspaceId }, include: { repositories: true, members: true }, orderBy: { name: "asc" } }),
    db.repository.findMany({ where: { workspaceId: viewer.workspaceId, trackingStatus: { not: "REMOVED" } }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
    db.member.findMany({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE", role: "MEMBER" }, include: { user: true } }),
  ]);
  const canShareWithTeam = spaces.some((s) => s.kind === "COMMON");
  const me = viewer.login;
  const projects = [...projectsRaw].sort((x, y) => byPersonalFirst(me)(x.name, y.name));
  const repos = [...reposRaw].sort((x, y) => byOwnerFirst(me)(x.fullName, y.fullName));
  const reviewerText = new Map(await Promise.all(projects.map(async (p) => [p.id, (await projectReviewerRefs(db, viewer.workspaceId, p.id)).join(", ")] as const)));
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="A project groups repositories and people for planning. Project membership never grants repository access, and a GitHub organization is not a project."
        actions={
          <Sheet title="New project" trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> New project</button>}>
            <ActionForm action={createProjectAction} submitLabel="Create project" closeOnSuccess>
              <div className="flex flex-col gap-3"><div><label className="label" htmlFor="p-name">Name</label><input id="p-name" name="name" className="input" required /></div><div><label className="label" htmlFor="p-rev">Required reviewers (optional)</label><input id="p-rev" name="reviewers" className="input" placeholder="GitHubLogin, org/team-slug" /></div><div><label className="label" htmlFor="p-desc">Description</label><input id="p-desc" name="description" className="input" /></div>{canShareWithTeam && <fieldset><legend className="label">Sharing</legend><label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="share" value="1" />Share with everyone in the team</label><p className="mt-1 text-[12px] text-ink-3">Leave it off to keep the project on this computer. You can change it later under the project&apos;s Sharing section.</p></fieldset>}</div>
            </ActionForm>
          </Sheet>
        }
      />
      {projects.length === 0 ? <Panel title="Projects" icon={Layers}><EmptyState icon={Layers} title="No projects yet" /></Panel> : (
        <div className="fit-grid" style={{ "--fit-min": "720px" } as React.CSSProperties}>
          {projects.map((p) => (
            <Panel key={p.id} title={p.name} icon={Layers} id={`p-${p.id}`} actions={<span className="hidden text-[12px] text-ink-3 sm:inline">{p.repositories.length} repositories · {p.members.length} people{reviewerText.get(p.id) ? ` · reviewers: ${reviewerText.get(p.id)}` : ""} · {p.spaceId ? "shared" : "only on this computer"}</span>}>
              <div className="flex flex-col divide-y divide-line">
                <details className="group p-4" open>
                  <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">Repositories <span className="font-normal text-ink-3">({p.repositories.length})</span></summary>
                  <ActionForm action={setProjectReposAction} submitLabel="Save repositories" resetOnSuccess={false} className="mt-3">
                    <input type="hidden" name="projectId" value={p.id} />
                    <RepoChecklist name="repo" repos={repos.map((r) => ({ id: r.id, fullName: r.fullName, checked: p.repositories.some((x) => x.repositoryId === r.id) }))} />
                  </ActionForm>
                </details>
                <details className="p-4">
                  <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">People <span className="font-normal text-ink-3">({p.members.length})</span></summary>
                  <div className="mt-3">
                    {members.length === 0 ? (
                      <div className="rounded-[8px] border border-dashed border-line-strong p-3 text-[12.5px] text-ink-2">
                        <p className="font-medium">Nobody to add yet.</p>
                        <p className="mt-1 text-ink-3">People appear here once they have joined your team. Invite them by GitHub username from the Team page (they get access to the team&apos;s private coordination repository only, never to your source repositories); after they accept and join, tick them here.</p>
                        <Link href="/team" className="btn mt-2 inline-flex">Invite people on Team</Link>
                      </div>
                    ) : (
                      <>
                        <ActionForm action={setProjectMembersAction} submitLabel="Save members" resetOnSuccess={false}>
                  <input type="hidden" name="projectId" value={p.id} />
                  <fieldset><legend className="label">People in this project</legend>
                    {members.length === 0 ? <p className="text-[12.5px] text-ink-3"></p> : <ul className="flex flex-col gap-1.5 text-[13px]">{members.map((m) => <li key={m.id}><label className="flex items-center gap-2"><input type="checkbox" name="member" value={m.id} defaultChecked={p.members.some((x) => x.memberId === m.id)} />@{m.user.login}</label></li>)}</ul>}
                  </fieldset>
                  <p className="mt-2 text-[12px] text-ink-3">Members see internal tasks of the projects they are in. Repository content still needs a repository grant.</p>
                </ActionForm>
                        <p className="mt-2 text-[12px] text-ink-3">Need someone else? <Link className="underline" href="/team">Invite people on Team</Link>.</p>
                      </>
                    )}
                  </div>
                </details>
                <details className="p-4">
                  <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">Required reviewers <span className="font-normal text-ink-3">({reviewerText.get(p.id) || "none"})</span></summary>
                  <div className="mt-3"><ActionForm action={setProjectReviewersAction} submitLabel="Save reviewers" resetOnSuccess={false} className="max-w-md">
                  <input type="hidden" name="projectId" value={p.id} />
                  <label className="label" htmlFor={`rv-${p.id}`}>Required reviewers</label>
                  <input id={`rv-${p.id}`} name="reviewers" className="input" defaultValue={reviewerText.get(p.id) ?? ""} placeholder="GitHubLogin, org/team-slug (empty = none)" />
                  <p className="mt-1 text-[12px] text-ink-3">Every open pull request in this project then waits for these people, whoever opened it. GitHub never lets an author approve their own pull request, so for the author the requirement is shown but cannot be met by them. Edit the same rule, or add finer ones, under Review routing.</p>
                </ActionForm></div>
                </details>
                <details className="p-4">
                  <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">Sharing <span className="font-normal text-ink-3">({p.spaceId ? "shared through a team space" : "only on this computer"})</span></summary>
                  <div className="mt-3"><ActionForm action={setProjectSpaceAction} submitLabel="Save sharing" resetOnSuccess={false} className="max-w-md">
                  <input type="hidden" name="projectId" value={p.id} />
                  <label className="label" htmlFor={`sp-${p.id}`}>Shared through</label>
                  <Select id={`sp-${p.id}`} name="spaceId" defaultValue={p.spaceId ?? ""} className="select">
                    <option value="">Only on this computer</option>
                    {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}{sp.kind === "COMMON" ? " (everyone in the team)" : " (restricted)"}</option>)}
                  </Select>
                  <p className="mt-1 text-[12px] text-ink-3">The project, its board and internal tasks are written to that space&apos;s private repository, so everyone who can read it sees them. Pick a restricted space for a smaller audience.</p>
                </ActionForm></div>
                </details>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
