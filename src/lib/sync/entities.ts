import type { Prisma, Space } from "@/generated/prisma/client";
import { refreshHubWatch } from "@/lib/hub/watch";
import type { Db } from "@/lib/db";
import { createColumnsForProject } from "@/lib/services/planning";
import type { Data } from "./merge";
export type { Data };

/**
 * Mergeport-owned entities that live in coordination spaces, and how each maps onto the local read model.
 * Only Mergeport-owned data is listed here. GitHub conversations, reviews, labels, branches and commits are fetched
 * through the acting person's own access and cached locally; they are never written to a coordination repository.
 *
 * Contract for every type: serialize(local row) must round-trip through apply(), otherwise sync would invent edits.
 */

export const ENTITY_SCHEMA = 1;

export type Ctx = { workspaceId: string; localMemberId: string; space: Space; commonSpaceId: string | null };
export type Listed = { id: string; spaceId: string | null; data: Data };

export type EntityDef = {
  type: string;
  order: number;
  setKeys?: string[];
  list(db: Db, ctx: { commonSpaceId: string | null }): Promise<Listed[]>;
  /** Returns false when a prerequisite entity is not materialized yet; the pull will not record the entity and retries it next time. */
  apply(db: Db, ctx: Ctx, id: string, data: Data | null, version: number): Promise<boolean | void>;
  /** Runs once after every entity of this type in a pull has been applied (cross-entity links). */
  post?(db: Db, ctx: Ctx, applied: { id: string; data: Data }[]): Promise<void>;
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: unknown) => (typeof s === "string" && s ? new Date(s.length === 10 ? s + "T00:00:00Z" : s) : null);
const repoEntityId = (githubId: bigint | string) => `repo-${githubId}`;
const bigOrNull = (v: unknown) => (v === null || v === undefined ? null : BigInt(String(v)));

async function repoByGithubId(db: Db, workspaceId: string, githubId: unknown) {
  if (githubId === null || githubId === undefined) return null;
  return db.repository.findUnique({ where: { workspaceId_githubId: { workspaceId, githubId: BigInt(String(githubId)) } } });
}

// ---------- repositories ----------

const repo: EntityDef = {
  type: "repo",
  order: 1,
  async list(db) {
    const rows = await db.repository.findMany({ where: { spaceId: { not: null }, trackingStatus: { not: "REMOVED" }, isDemo: false }, include: { owner: true } });
    return rows.map((r) => ({
      id: repoEntityId(r.githubId),
      spaceId: r.spaceId,
      data: {
        githubId: r.githubId.toString(), fullName: r.fullName, name: r.name, htmlUrl: r.htmlUrl, description: r.description, visibility: r.visibility,
        isFork: r.isFork, parentGithubId: r.parentGithubId?.toString() ?? null, parentFullName: r.parentFullName, defaultBranch: r.defaultBranch, archived: r.archived,
        owner: { githubId: r.owner.githubId.toString(), login: r.owner.login, type: r.owner.type, avatarUrl: r.owner.avatarUrl },
      },
    }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      const gid = BigInt(id.replace(/^repo-/, ""));
      const r = await repoByGithubId(db, ctx.workspaceId, gid);
      if (r && r.spaceId === ctx.space.id) {
        await db.repository.update({ where: { id: r.id }, data: { trackingStatus: "REMOVED", spaceId: null } });
        await db.repositoryGrant.updateMany({ where: { repositoryId: r.id, revokedAt: null }, data: { revokedAt: new Date() } });
        refreshHubWatch();
      }
      return;
    }
    const o = data.owner as { githubId: string; login: string; type: "USER" | "ORGANIZATION" | "UNKNOWN"; avatarUrl: string | null };
    const owner = await db.githubOwner.upsert({ where: { githubId: BigInt(o.githubId) }, create: { githubId: BigInt(o.githubId), login: o.login, type: o.type, avatarUrl: o.avatarUrl }, update: { login: o.login, type: o.type, avatarUrl: o.avatarUrl } });
    const f = {
      ownerId: owner.id, name: String(data.name), fullName: String(data.fullName), htmlUrl: String(data.htmlUrl), description: (data.description as string | null) ?? null,
      visibility: data.visibility as "PUBLIC" | "PRIVATE" | "INTERNAL" | "UNKNOWN", isFork: !!data.isFork, parentGithubId: bigOrNull(data.parentGithubId), parentFullName: (data.parentFullName as string | null) ?? null,
      defaultBranch: (data.defaultBranch as string | null) ?? null, archived: !!data.archived, spaceId: ctx.space.id, trackingStatus: "ACTIVE" as const,
    };
    const githubId = BigInt(String(data.githubId));
    const r = await db.repository.upsert({ where: { workspaceId_githubId: { workspaceId: ctx.workspaceId, githubId } }, create: { workspaceId: ctx.workspaceId, githubId, ...f }, update: f });
    // Application-level visibility mirrors the space audience: this person may see what the space shares.
    await db.repositoryGrant.upsert({
      where: { memberId_repositoryId: { memberId: ctx.localMemberId, repositoryId: r.id } },
      create: { memberId: ctx.localMemberId, repositoryId: r.id, grantedById: ctx.localMemberId, canManageWork: ctx.space.canWrite, canReview: ctx.space.canWrite },
      update: { revokedAt: null, canManageWork: ctx.space.canWrite, canReview: ctx.space.canWrite },
    });
    refreshHubWatch();
  },
};

// ---------- projects ----------

const project: EntityDef = {
  type: "project",
  order: 2,
  setKeys: ["repoIds"],
  async list(db) {
    const rows = await db.project.findMany({ where: { spaceId: { not: null } }, include: { repositories: { include: { repository: true } } } });
    return rows.map((p) => ({
      id: p.id, spaceId: p.spaceId,
      data: { name: p.name, slug: p.slug, description: p.description, repoIds: p.repositories.map((x) => repoEntityId(x.repository.githubId)).sort() },
    }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.project.deleteMany({ where: { id } });
      return;
    }
    const f = { name: String(data.name), slug: String(data.slug), description: (data.description as string | null) ?? null, spaceId: ctx.space.id };
    await db.project.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
    await createColumnsForProject(db, id);
    await db.projectMember.upsert({ where: { projectId_memberId: { projectId: id, memberId: ctx.localMemberId } }, create: { projectId: id, memberId: ctx.localMemberId }, update: {} });
    const wanted: string[] = [];
    for (const rid of (data.repoIds as string[]) ?? []) {
      const r = await repoByGithubId(db, ctx.workspaceId, rid.replace(/^repo-/, ""));
      if (r) wanted.push(r.id);
    }
    await db.projectRepository.deleteMany({ where: { projectId: id, repositoryId: { notIn: wanted } } });
    for (const repositoryId of wanted) await db.projectRepository.upsert({ where: { projectId_repositoryId: { projectId: id, repositoryId } }, create: { projectId: id, repositoryId }, update: {} });
  },
};

// ---------- milestones ----------

const milestone: EntityDef = {
  type: "milestone",
  order: 3,
  setKeys: ["repoLinks"],
  async list(db, { commonSpaceId }) {
    const rows = await db.dashboardMilestone.findMany({ include: { project: true, repoLinks: { include: { repository: true } } } });
    return rows.map((m) => ({
      id: m.id,
      spaceId: m.project ? m.project.spaceId : commonSpaceId,
      data: {
        name: m.name, description: m.description, projectId: m.projectId, startDate: day(m.startDate), targetDate: day(m.targetDate), status: m.status,
        repoLinks: m.repoLinks.map((l) => `${l.repository.githubId}#${l.githubMilestoneNumber}`).sort(),
      },
    }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.dashboardMilestone.deleteMany({ where: { id } });
      return;
    }
    const projectId = (data.projectId as string | null) ?? null;
    const p = projectId ? await db.project.findUnique({ where: { id: projectId } }) : null;
    const f = { name: String(data.name), description: (data.description as string | null) ?? null, projectId: p ? projectId : null, startDate: toDate(data.startDate), targetDate: toDate(data.targetDate), status: String(data.status ?? "OPEN") };
    await db.dashboardMilestone.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
    const wanted: string[] = [];
    for (const link of (data.repoLinks as string[]) ?? []) {
      const [gid, num] = link.split("#");
      const r = await repoByGithubId(db, ctx.workspaceId, gid);
      if (!r) continue;
      wanted.push(r.id);
      await db.milestoneRepoLink.upsert({ where: { milestoneId_repositoryId: { milestoneId: id, repositoryId: r.id } }, create: { milestoneId: id, repositoryId: r.id, githubMilestoneNumber: Number(num) }, update: { githubMilestoneNumber: Number(num) } });
    }
    await db.milestoneRepoLink.deleteMany({ where: { milestoneId: id, repositoryId: { notIn: wanted } } });
  },
};

// ---------- cards (planning items) ----------

const card: EntityDef = {
  type: "card",
  order: 4,
  setKeys: ["blockedBy"],
  async list(db) {
    const rows = await db.planningItem.findMany({ where: { project: { spaceId: { not: null } } }, include: { project: true, column: true, workItem: { include: { repository: true } }, blockedBy: true } });
    return rows.map((c) => ({
      id: c.id, spaceId: c.project.spaceId,
      data: {
        projectId: c.projectId, columnKey: c.column.key, position: c.position, title: c.title, description: c.description,
        workRepoGithubId: c.workItem ? c.workItem.repository.githubId.toString() : (c.workRepoGithubId?.toString() ?? null),
        workNumber: c.workItem ? c.workItem.number : c.workNumber,
        assigneeLogin: c.assigneeLogin, assignedByLogin: c.assignedByLogin, authorLogin: c.authorLogin, labels: c.labels, priority: c.priority, due: day(c.dueDate), milestoneId: c.milestoneId,
        blockedBy: c.blockedBy.map((l) => l.fromId).sort(),
      },
    }));
  },
  async apply(db, ctx, id, data, version) {
    if (!data) {
      await db.planningItem.deleteMany({ where: { id } });
      return;
    }
    const projectId = String(data.projectId);
    const col = await db.planningColumn.findFirst({ where: { projectId, key: String(data.columnKey) } });
    if (!col) return false; // the project entity has not been applied yet; the next pull retries
    const work = data.workRepoGithubId !== null && data.workRepoGithubId !== undefined ? await repoByGithubId(db, ctx.workspaceId, data.workRepoGithubId) : null;
    const wi = work && data.workNumber ? await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: work.id, number: Number(data.workNumber) } } }) : null;
    const ms = data.milestoneId ? await db.dashboardMilestone.findUnique({ where: { id: String(data.milestoneId) } }) : null;
    const f = {
      projectId, columnId: col.id, position: Number(data.position), title: String(data.title), description: (data.description as string | null) ?? null,
      workItemId: wi?.id ?? null, workRepoGithubId: bigOrNull(data.workRepoGithubId), workNumber: data.workNumber === null || data.workNumber === undefined ? null : Number(data.workNumber),
      assigneeLogin: (data.assigneeLogin as string | null) ?? null, assignedByLogin: (data.assignedByLogin as string | null) ?? null, authorLogin: (data.authorLogin as string | null) ?? null,
      labels: (data.labels ?? []) as Prisma.InputJsonValue, priority: Number(data.priority ?? 0), dueDate: toDate(data.due), milestoneId: ms ? ms.id : null, version,
    };
    await db.planningItem.upsert({ where: { id }, create: { id, createdById: ctx.localMemberId, ...f }, update: f });
  },
  async post(db, _ctx, applied) {
    for (const a of applied) {
      const want = ((a.data.blockedBy as string[]) ?? []).filter((x) => x !== a.id);
      const existing = await db.planningItem.findMany({ where: { id: { in: want } }, select: { id: true } });
      const ok = existing.map((e) => e.id);
      await db.planningLink.deleteMany({ where: { toId: a.id, fromId: { notIn: ok } } });
      for (const fromId of ok) await db.planningLink.upsert({ where: { fromId_toId: { fromId, toId: a.id } }, create: { fromId, toId: a.id }, update: {} });
    }
  },
};

// ---------- task comments (one file per comment, so two people never edit the same file) ----------

const taskcomment: EntityDef = {
  type: "taskcomment",
  order: 5,
  async list(db) {
    const rows = await db.taskComment.findMany({ where: { item: { project: { spaceId: { not: null } } } }, include: { item: { include: { project: true } } } });
    return rows.map((c) => ({ id: c.id, spaceId: c.item.project.spaceId, data: { itemId: c.itemId, authorLogin: c.authorLogin, kind: c.kind, body: c.body, createdAt: iso(c.createdAt), editedAt: iso(c.editedAt) } }));
  },
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.taskComment.deleteMany({ where: { id } });
      return;
    }
    const item = await db.planningItem.findUnique({ where: { id: String(data.itemId) }, select: { id: true } });
    if (!item) return false; // the card has not been applied yet; the next pull retries
    const f = { itemId: item.id, authorLogin: String(data.authorLogin), kind: String(data.kind ?? "COMMENT"), body: String(data.body), createdAt: toDate(data.createdAt) ?? new Date(), editedAt: toDate(data.editedAt) };
    await db.taskComment.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- task checklist items (one file per item) ----------

const checkitem: EntityDef = {
  type: "checkitem",
  order: 5,
  async list(db) {
    const rows = await db.taskCheckItem.findMany({ where: { item: { project: { spaceId: { not: null } } } }, include: { item: { include: { project: true } } } });
    return rows.map((c) => ({ id: c.id, spaceId: c.item.project.spaceId, data: { itemId: c.itemId, text: c.text, done: c.done, position: c.position, doneByLogin: c.doneByLogin, doneAt: iso(c.doneAt), createdAt: iso(c.createdAt) } }));
  },
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.taskCheckItem.deleteMany({ where: { id } });
      return;
    }
    const item = await db.planningItem.findUnique({ where: { id: String(data.itemId) }, select: { id: true } });
    if (!item) return false; // the card has not been applied yet; the next pull retries
    const f = { itemId: item.id, text: String(data.text), done: !!data.done, position: Number(data.position ?? 0), doneByLogin: (data.doneByLogin as string | null) ?? null, doneAt: toDate(data.doneAt), createdAt: toDate(data.createdAt) ?? new Date() };
    await db.taskCheckItem.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- review routing ----------

const rule: EntityDef = {
  type: "rule",
  order: 5,
  async list(db, { commonSpaceId }) {
    const rows = await db.reviewRule.findMany({ include: { repository: true, project: true } });
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.scope === "REPOSITORY" ? (r.repository?.spaceId ?? null) : r.scope === "PROJECT" ? (r.project?.spaceId ?? null) : commonSpaceId,
      data: { scope: r.scope, repoGithubId: r.repository?.githubId.toString() ?? null, projectId: r.projectId, ownerLogin: r.ownerLogin, labels: r.labels, reviewers: r.reviewers, semantics: r.semantics, reason: r.reason, enabled: r.enabled },
    }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.reviewRule.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.repoGithubId);
    const f = {
      scope: data.scope as "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE", repositoryId: r?.id ?? null, projectId: (data.projectId as string | null) ?? null, ownerLogin: (data.ownerLogin as string | null) ?? null,
      labels: (data.labels ?? []) as Prisma.InputJsonValue, reviewers: (data.reviewers ?? []) as Prisma.InputJsonValue, semantics: data.semantics as "ANY" | "ALL", reason: String(data.reason), enabled: !!data.enabled,
    };
    await db.reviewRule.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

// ---------- waiting rules ("this work waits on these people until merged") ----------

const waitrule: EntityDef = {
  type: "waitrule",
  order: 5,
  async list(db, { commonSpaceId }) {
    const rows = await db.waitingRule.findMany({ include: { repository: true, project: true } });
    return rows.map((r) => ({
      id: r.id,
      spaceId: r.scope === "REPOSITORY" ? (r.repository?.spaceId ?? null) : r.scope === "PROJECT" ? (r.project?.spaceId ?? null) : commonSpaceId,
      data: { scope: r.scope, repoGithubId: r.repository?.githubId.toString() ?? null, projectId: r.projectId, ownerLogin: r.ownerLogin, itemType: r.itemType, labels: r.labels, authors: r.authors, includeDrafts: r.includeDrafts, waitingOn: r.waitingOn, reason: r.reason, enabled: r.enabled },
    }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.waitingRule.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.repoGithubId);
    const f = {
      scope: data.scope as "REPOSITORY" | "OWNER" | "PROJECT" | "WORKSPACE", repositoryId: r?.id ?? null, projectId: (data.projectId as string | null) ?? null, ownerLogin: (data.ownerLogin as string | null) ?? null,
      itemType: String(data.itemType ?? "PULL_REQUEST"), labels: (data.labels ?? []) as Prisma.InputJsonValue, authors: (data.authors ?? []) as Prisma.InputJsonValue, includeDrafts: !!data.includeDrafts,
      waitingOn: (data.waitingOn ?? []) as Prisma.InputJsonValue, reason: String(data.reason), enabled: !!data.enabled,
    };
    await db.waitingRule.upsert({ where: { id }, create: { id, workspaceId: ctx.workspaceId, ...f }, update: f });
  },
};

// ---------- fork mappings and upstream triage ----------

const forkmap: EntityDef = {
  type: "forkmap",
  order: 6,
  async list(db) {
    const rows = await db.forkMapping.findMany({ where: { fork: { spaceId: { not: null } } }, include: { fork: true, upstream: true } });
    return rows.map((m) => ({ id: m.id, spaceId: m.fork.spaceId, data: { forkRepoGithubId: m.fork.githubId.toString(), upstreamRepoGithubId: m.upstream.githubId.toString(), forkBranch: m.forkBranch, upstreamBranch: m.upstreamBranch } }));
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.forkMapping.deleteMany({ where: { id } });
      return;
    }
    const fork = await repoByGithubId(db, ctx.workspaceId, data.forkRepoGithubId);
    const up = await repoByGithubId(db, ctx.workspaceId, data.upstreamRepoGithubId);
    if (!fork || !up) return false;
    const f = { forkRepoId: fork.id, upstreamRepoId: up.id, forkBranch: String(data.forkBranch), upstreamBranch: String(data.upstreamBranch) };
    await db.forkMapping.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

const triage: EntityDef = {
  type: "triage",
  order: 7,
  async list(db) {
    const rows = await db.upstreamIssueTriage.findMany({ where: { mapping: { fork: { spaceId: { not: null } } } }, include: { mapping: { include: { fork: true } } } });
    return rows.map((t) => ({ id: t.id, spaceId: t.mapping.fork.spaceId, data: { mappingId: t.mappingId, issueNumber: t.issueNumber, title: t.title, htmlUrl: t.htmlUrl, status: t.status, note: t.note } }));
  },
  async apply(db, _ctx, id, data) {
    if (!data) {
      await db.upstreamIssueTriage.deleteMany({ where: { id } });
      return;
    }
    const m = await db.forkMapping.findUnique({ where: { id: String(data.mappingId) } });
    if (!m) return false;
    const f = { mappingId: m.id, issueNumber: Number(data.issueNumber), title: String(data.title), htmlUrl: String(data.htmlUrl), status: data.status as "UNTRIAGED" | "WATCHING" | "RELEVANT" | "ADDRESSED" | "IGNORED", note: (data.note as string | null) ?? null };
    await db.upstreamIssueTriage.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

// ---------- manual waiting annotations ----------

const waiting: EntityDef = {
  type: "waiting",
  order: 8,
  async list(db) {
    const rows = await db.waitingRecord.findMany({ where: { source: "MANUAL" }, include: { workItem: { include: { repository: true } }, planningItem: { include: { project: true } } } });
    const out: Listed[] = [];
    for (const w of rows) {
      const spaceId = w.workItem?.repository.spaceId ?? w.planningItem?.project.spaceId ?? null;
      out.push({
        id: w.id, spaceId,
        data: {
          workRepoGithubId: w.workItem?.repository.githubId.toString() ?? null, workNumber: w.workItem?.number ?? null, cardId: w.planningItemId,
          reviewerKind: w.reviewerKind, reviewerRef: w.reviewerRef, reason: w.reason, status: w.status, startedAt: iso(w.startedAt), clearedAt: iso(w.clearedAt), clearReason: w.clearReason,
        },
      });
    }
    return out;
  },
  async apply(db, ctx, id, data) {
    if (!data) {
      await db.waitingRecord.deleteMany({ where: { id } });
      return;
    }
    const r = await repoByGithubId(db, ctx.workspaceId, data.workRepoGithubId);
    const wi = r && data.workNumber ? await db.workItem.findUnique({ where: { repositoryId_number: { repositoryId: r.id, number: Number(data.workNumber) } } }) : null;
    const card = data.cardId ? await db.planningItem.findUnique({ where: { id: String(data.cardId) } }) : null;
    if (!wi && !card) return false;
    const f = {
      workspaceId: ctx.workspaceId, workItemId: wi?.id ?? null, planningItemId: card?.id ?? null, source: "MANUAL" as const, reviewerKind: data.reviewerKind as "USER" | "TEAM" | "EXTERNAL_ROLE",
      reviewerRef: String(data.reviewerRef), reason: String(data.reason), status: data.status as "PENDING" | "SATISFIED" | "CANCELLED" | "STALE", startedAt: new Date(String(data.startedAt)),
      clearedAt: toDate(data.clearedAt), clearReason: (data.clearReason as string | null) ?? null,
    };
    await db.waitingRecord.upsert({ where: { id }, create: { id, ...f }, update: f });
  },
};

export const ENTITY_TYPES: EntityDef[] = [repo, project, milestone, card, taskcomment, checkitem, rule, waitrule, forkmap, triage, waiting];
export const entityDef = (type: string) => ENTITY_TYPES.find((t) => t.type === type);
export const entityPath = (type: string, id: string) => `entities/${type}/${id}.json`;
export const parseEntityPath = (path: string): { type: string; id: string } | null => {
  const m = /^entities\/([a-z]+)\/([A-Za-z0-9_-]+)\.json$/.exec(path);
  return m ? { type: m[1], id: m[2] } : null;
};
