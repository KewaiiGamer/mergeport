import { HubError, type EntityEvent, type EventJson, type HubClient, type Me, type Op, type OpResult } from "./types";
import type { EntityFile } from "@/lib/sync/engine";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function normalizeHubOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new HubError("unknown", "Not a valid hub URL");
  }
  const loopback = LOOPBACK.has(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new HubError("unknown", "Hub URLs must use https");
  return u.origin;
}

/**
 * Every hub request has a deadline. Without one a connection that went quiet (a proxy dropped it after a hub restart, a laptop woke
 * up on another network) leaves its sync cycle waiting forever, and every later automatic sync of that space waits behind it.
 * The signal also covers reading the body.
 */
export const HUB_REQUEST_TIMEOUT_MS = 20_000;
export const HUB_BULK_TIMEOUT_MS = 60_000; // snapshot and push can carry a lot

async function send(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new HubError("network", e instanceof Error ? e.message : "network error");
  }
}

function failure(res: Response): HubError {
  const status = res.status;
  if (status === 401) return new HubError("auth", "Sign in again", { status });
  if (status === 403) return new HubError("forbidden", "Not allowed", { status });
  if (status === 404) return new HubError("not-found", "Not found", { status });
  if (status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return new HubError("rate-limited", "Rate limited", { status, retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? ra : undefined });
  }
  return new HubError("unknown", `Hub returned ${status}`, { status });
}

async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new HubError("unknown", "Hub sent an unreadable response", { status: res.status });
  }
}

export class HttpHubClient implements HubClient {
  private readonly origin: string;
  constructor(origin: string, private getToken: () => Promise<string | null>, private fetchImpl: typeof fetch = (...a) => fetch(...a), private timeouts: { request?: number; bulk?: number } = {}) {
    this.origin = normalizeHubOrigin(origin);
  }

  private async call(path: string, init: RequestInit = {}, allow410 = false, bulk = false): Promise<Response | "gone" | "history"> {
    const token = await this.getToken();
    if (!token) throw new HubError("auth", "Not signed in");
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
    if (init.body) headers["content-type"] = "application/json";
    const res = await send(this.fetchImpl, this.origin + path, { ...init, headers, redirect: "error" }, bulk ? (this.timeouts.bulk ?? HUB_BULK_TIMEOUT_MS) : (this.timeouts.request ?? HUB_REQUEST_TIMEOUT_MS));
    if (res.status === 410 && allow410) {
      const b = (await res.json().catch(() => null)) as { reason?: string } | null;
      return b?.reason === "history" ? "history" : "gone";
    }
    if (!res.ok) throw failure(res);
    return res;
  }

  async me(): Promise<Me> {
    return json<Me>((await this.call("/me")) as Response);
  }

  async pull(spaceId: string, since: bigint, after?: string) {
    const res = await this.call(`/spaces/${encodeURIComponent(spaceId)}/entities?since=${since}${after ? `&after=${encodeURIComponent(after)}` : ""}`, {}, true);
    if (res === "gone" || res === "history") return res;
    const b = await json<{ epoch?: string; seq: string; seqOp?: string; events: EventJson[]; more?: boolean }>(res);
    const events: EntityEvent[] = b.events.map((e) => ({ ...e, seq: BigInt(e.seq) }));
    return { epoch: b.epoch, seq: BigInt(b.seq), seqOp: b.seqOp, events, more: b.more };
  }

  async snapshot(spaceId: string) {
    const b = await json<{ epoch?: string; seq: string; seqOp?: string; entities: EntityFile[] }>((await this.call(`/spaces/${encodeURIComponent(spaceId)}/snapshot`, {}, false, true)) as Response);
    return { epoch: b.epoch, seq: BigInt(b.seq), seqOp: b.seqOp, entities: b.entities };
  }

  async push(spaceId: string, ops: Op[]) {
    const res = (await this.call(`/spaces/${encodeURIComponent(spaceId)}/ops`, { method: "POST", body: JSON.stringify({ ops }) }, false, true)) as Response;
    const b = await json<{ results: OpResult[]; seq: string }>(res);
    return { results: b.results, seq: BigInt(b.seq) };
  }
}

export async function checkHubHealth(origin: string, supportedSchema = 1, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ teamName: string | null; publicUrl: string; githubHost: string }> {
  const typed = normalizeHubOrigin(origin);
  const res = await send(fetchImpl, typed + "/health", { headers: { accept: "application/json" }, redirect: "error" }, HUB_REQUEST_TIMEOUT_MS);
  if (!res.ok) throw failure(res);
  const h = await json<{ team?: { name: string } | null; schema?: number; publicUrl?: string; githubHost?: string }>(res);
  if (typeof h.schema !== "number") throw new HubError("unknown", "Not a Mergeport hub");
  if (h.schema > supportedSchema) throw new HubError("schema", "This hub needs a newer Mergeport");
  let publicUrl: string;
  try {
    publicUrl = normalizeHubOrigin(h.publicUrl ?? "");
  } catch {
    throw new HubError("unknown", "Hub reports an invalid public URL");
  }
  if (publicUrl !== typed) throw new HubError("unknown", "Hub's public URL does not match the address you typed");
  if (h.githubHost !== "github.com") throw new HubError("unknown", "Hub uses a GitHub host Mergeport does not support");
  return { teamName: h.team?.name ?? null, publicUrl, githubHost: h.githubHost };
}
