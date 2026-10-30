import type { EntityFile } from "@/lib/sync/engine";
import type { CoordinationStore } from "@/lib/sync/store";

export type Op = { opId: string; type: string; entityId: string; kind: "UPSERT" | "DELETE"; baseVersion: number; data?: Record<string, unknown> };
export type EntityJson = EntityFile;
export type EventJson = EntityJson & { seq: string; opId: string };
export type EntityEvent = Omit<EventJson, "seq"> & { seq: bigint };
export type OpResult = { opId: string; status: "applied" | "duplicate" | "stale"; version: number; current?: EntityJson };

export type Me = {
  member: { githubId: string; login: string; name: string | null; avatarUrl: string | null; role: string; status: string };
  team: { id: string; name: string };
  members: unknown[];
  spaces: { id: string; kind: "COMMON" | "RESTRICTED"; name: string; canWrite: boolean; seq: string }[];
  /** Instant GitHub updates through the hub: whether the hub has a webhook secret, and what it last saw (event name only). */
  webhooks: { enabled: boolean; appSlug: string | null; lastDeliveryAt: string | null; lastEvent: string | null };
};

export interface HubClient {
  me(): Promise<Me>;
  /** `after` is the op this client last read at `since`; "history" means the hub holds a different op there (it was restored from a backup). */
  pull(spaceId: string, since: bigint, after?: string): Promise<{ epoch?: string; seq: bigint; seqOp?: string; events: EntityEvent[]; more?: boolean } | "gone" | "history">;
  snapshot(spaceId: string): Promise<{ epoch?: string; seq: bigint; seqOp?: string; entities: EntityFile[] }>;
  push(spaceId: string, ops: Op[]): Promise<{ results: OpResult[]; seq: bigint }>;
}

export type Backend = { kind: "github"; store: CoordinationStore } | { kind: "hub"; client: HubClient };

export type HubErrorKind = "network" | "auth" | "forbidden" | "not-found" | "rate-limited" | "schema" | "unknown";

export class HubError extends Error {
  readonly kind: HubErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  constructor(kind: HubErrorKind, message?: string, extra: { status?: number; retryAfterSeconds?: number } = {}) {
    super(message ?? kind);
    this.name = "HubError";
    this.kind = kind;
    this.status = extra.status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}
