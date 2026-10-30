import { ValidationError } from "@/lib/errors";
import type { HubAdminApi, HubAdminSpace, HubMember, HubSessionPort, HubSpaceInfo, HubWebhooks } from "@/lib/hub/ports";
import { hubSessionPort } from "@/lib/hub/ports-impl";

/**
 * Team administration in hub mode. The hub enforces every rule; the local checks here only give friendlier
 * messages before a request is sent. GitHub mode stays in `TeamService`.
 */
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

export type HubOverview = { teamName: string; me: HubMember; members: HubMember[]; spaces: HubSpaceInfo[]; canAdmin: boolean; webhooks: HubWebhooks };

export class HubTeamService {
  constructor(
    private readonly api: HubAdminApi,
    private readonly actorGithubId: string,
  ) {}

  private last: HubOverview | null = null;

  async overview(): Promise<HubOverview> {
    const r = await this.api.me();
    return (this.last = { teamName: r.team.name, me: r.member, members: r.members, spaces: r.spaces, canAdmin: r.member.role === "OWNER" || r.member.role === "ADMIN", webhooks: r.webhooks });
  }

  // Local checks are UX only. A cached "no" is re-checked against the hub once, so a promotion is never blocked here.
  private async requireAdmin(what: string): Promise<HubOverview> {
    let o = this.last ?? (await this.overview());
    if (!o.canAdmin && this.last === o) o = await this.overview();
    if (!o.canAdmin) throw new ValidationError(`Only admins can ${what}.`);
    return o;
  }

  private async roleOf(o: HubOverview, githubId: string): Promise<HubMember["role"] | undefined> {
    const found = o.members.find((m) => m.githubId === githubId);
    if (found) return found.role;
    return (await this.overview()).members.find((m) => m.githubId === githubId)?.role;
  }

  private async mutate<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } finally {
      this.last = null;
    }
  }

  private static role(role: string): "ADMIN" | "MEMBER" | "READER" {
    if (role !== "ADMIN" && role !== "MEMBER" && role !== "READER") throw new ValidationError("Choose Admin, Member or Reader.");
    return role;
  }

  async invite(login: string, role: "ADMIN" | "MEMBER" | "READER" = "MEMBER"): Promise<void> {
    await this.requireAdmin("invite people");
    const l = login.trim().replace(/^@/, "").toLowerCase();
    if (!l || !LOGIN.test(l)) throw new ValidationError("Enter a valid GitHub username.");
    const r = HubTeamService.role(role);
    await this.mutate(() => this.api.invite(l, r));
  }

  async changeRole(githubId: string, role: "ADMIN" | "MEMBER" | "READER"): Promise<void> {
    const o = await this.requireAdmin("change roles");
    const r = HubTeamService.role(role);
    if (githubId === this.actorGithubId) throw new ValidationError("You cannot change your own role.");
    if ((await this.roleOf(o, githubId)) === "OWNER") throw new ValidationError("The owner's role cannot be changed.");
    await this.mutate(() => this.api.setRole(githubId, r));
  }

  async removeMember(githubId: string): Promise<void> {
    const o = await this.requireAdmin("remove people");
    if ((await this.roleOf(o, githubId)) === "OWNER") throw new ValidationError("The owner cannot be removed.");
    await this.mutate(() => this.api.removeMember(githubId));
  }

  /** Removed members, for the owner's "Removed" list. Empty for everyone else: the hub does not tell them. */
  async removedMembers(): Promise<HubMember[]> {
    const o = this.last ?? (await this.overview());
    return o.me.role === "OWNER" ? this.api.removedMembers() : [];
  }

  /** Removal can be undone by the owner only (the hub re-checks). */
  async reinstateMember(githubId: string, role: string): Promise<void> {
    const o = this.last ?? (await this.overview());
    if (o.me.role !== "OWNER") throw new ValidationError("Only the owner can reinstate someone.");
    const r = HubTeamService.role(role);
    await this.mutate(() => this.api.reinstateMember(githubId, r));
  }

  /** Spaces with their members. Admins only; the hub re-checks. */
  async adminSpaces(): Promise<HubAdminSpace[]> {
    await this.requireAdmin("see space members");
    return this.api.adminSpaces();
  }

  async createSpace(name: string, members: { githubId: string; canWrite: boolean }[]): Promise<HubSpaceInfo> {
    await this.requireAdmin("create spaces");
    const n = name.trim();
    if (!n) throw new ValidationError("Give the space a name.");
    return this.mutate(() => this.api.createSpace(n, members));
  }

  async updateSpace(id: string, p: { name?: string; members?: { githubId: string; canWrite: boolean }[] }): Promise<void> {
    await this.requireAdmin("change spaces");
    const patch = { ...p };
    if (p.name !== undefined) {
      patch.name = p.name.trim();
      if (!patch.name) throw new ValidationError("Give the space a name.");
    }
    await this.mutate(() => this.api.updateSpace(id, patch));
  }

  async deleteSpace(id: string, opts: { confirmed: boolean }): Promise<void> {
    await this.requireAdmin("delete spaces");
    if (opts.confirmed !== true) throw new ValidationError("Deleting this space removes its projects, cards and tasks from every member's computer.");
    await this.mutate(() => this.api.deleteSpace(id));
  }

  /** Stores the GitHub App's webhook secret on the hub. OWNER only (the hub re-checks); the secret is validated here and never echoed in an error. */
  async setGithubWebhook(secret: string, appSlug?: string | null): Promise<void> {
    await this.requireOwner("set up instant GitHub updates");
    if (secret.length < 32 || secret.length > 256) throw new ValidationError("The secret must be 32 to 256 characters.");
    if (appSlug && !/^[A-Za-z0-9-]{1,100}$/.test(appSlug)) throw new ValidationError("The App's slug may only contain letters, digits and hyphens.");
    await this.mutate(() => this.api.setGithubWebhook(secret, appSlug || undefined));
  }

  async clearGithubWebhook(): Promise<void> {
    await this.requireOwner("turn off instant GitHub updates");
    await this.mutate(() => this.api.clearGithubWebhook());
  }

  private async requireOwner(what: string): Promise<HubOverview> {
    const o = await this.overview();
    if (o.me.role !== "OWNER") throw new ValidationError(`Only the owner can ${what}.`);
    return o;
  }

  /** Ends the session on the hub (a down hub does not block it), then forgets it locally. */
  async signOut(dbFile: string, session: Pick<HubSessionPort, "remove"> = hubSessionPort): Promise<{ switchTo: "github" }> {
    this.last = null;
    try {
      await this.api.logout();
    } catch {
      // the hub being unreachable must not keep the user signed in here
    }
    await session.remove(dbFile);
    return { switchTo: "github" };
  }
}
