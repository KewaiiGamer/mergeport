import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { EntityJson, EventJson, Op, OpResult } from "@/lib/hub/types";

type Member = { githubId: string; login: string; role: string; status: "ACTIVE" | "REMOVED" };
type Ev = { seq: bigint; opId: string; entity: EntityJson };
type Space = { id: string; kind: "COMMON" | "RESTRICTED"; name: string; members: Set<string>; seq: bigint; entities: Map<string, EntityJson>; events: Ev[]; minSeq: bigint };
type Msg = Record<string, unknown>;

export class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  /** Every string passed to send(). */
  sent: string[] = [];
  closed = false;
  constructor(readonly member: Member | null, private hub: FakeHub) {}
  /** The set from the last `{ t: "watch" }` this socket sent (the hub replaces the set each time), as a real hub keeps it. */
  watched = new Set<string>();
  /** Every `watch` message in send order (the repos array of each). */
  watches: string[][] = [];
  send(data: string) {
    this.sent.push(data);
    try {
      const m = JSON.parse(data) as { t?: string; repos?: unknown };
      if (m.t === "watch" && Array.isArray(m.repos)) {
        this.watches.push(m.repos.map(String));
        this.watched = new Set(m.repos.slice(0, 2000).map(String));
      }
    } catch {
      // not JSON: only recorded
    }
  }
  close(code = 1000) {
    this.deliverClose(code);
  }
  deliver(m: Msg) {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify(m) });
  }
  deliverClose(code: number) {
    if (this.closed) return;
    this.closed = true;
    this.hub.sockets.delete(this);
    this.onclose?.({ code });
  }
}

export class FakeHub {
  publicUrl: string | undefined;
  githubHost = "github.com";
  sockets = new Set<FakeSocket>();
  private schema = 1;
  private members = new Map<string, Member>();
  private spaces = new Map<string, Space>();
  private server: http.Server | null = null;
  private conns = new Set<Socket>();
  private port = 0;
  private failures = 0;
  private failKind: "network" | "auth" | "forbidden" | "not-found" | "rate-limited" | "unknown" = "network";
  private revoked = new Set<string>();
  private dropNext = false;
  private stale = new Set<string>();
  /** Number of POST /ops requests that reached the handler. */
  opsRequests = 0;
  private pending = new Map<string, { seq: bigint; timer: NodeJS.Timeout }>();

  addMember(githubId: string, login: string, role: string) {
    this.members.set(githubId, { githubId, login, role, status: "ACTIVE" });
  }
  token(githubId: string) {
    return `tok-${githubId}`;
  }
  createSpace(id: string, kind: "COMMON" | "RESTRICTED", name: string, members: string[] = []) {
    this.spaces.set(id, { id, kind, name, members: new Set(members), seq: 0n, entities: new Map(), events: [], minSeq: 0n });
  }
  setSchema(n: number) {
    this.schema = n;
  }
  failNext(n: number, kind: "network" | "auth" | "forbidden" | "not-found" | "rate-limited" | "unknown" = "network") {
    this.failures = n;
    this.failKind = kind;
  }
  /** The member's token stops working: every request answers 401. */
  revokeToken(githubId: string) {
    this.revoked.add(githubId);
  }
  setRole(githubId: string, role: string) {
    const m = this.members.get(githubId);
    if (m) m.role = role;
  }
  /** Relays a GitHub webhook delivery the way the hub does: to every connection that watches `repoId`, in arrival order. Returns how many got it. */
  relayGithub(repoId: string, event: string, payload: unknown | null, delivery = `d-${++this.deliveries}`): number {
    let n = 0;
    for (const k of this.sockets) {
      if (!k.watched.has(repoId)) continue;
      k.deliver({ t: "gh", repoId, event, delivery, payload });
      n++;
    }
    return n;
  }
  private deliveries = 0;
  /** Webhook status answered by GET /me. */
  webhooks = { enabled: false, appSlug: null as string | null, lastDeliveryAt: null as string | null, lastEvent: null as string | null };
  /** Simulates a restored or rebuilt hub: its sequence goes back to `seq` and no history is kept. */
  resetSeq(spaceId: string, seq = 0n) {
    const s = this.spaces.get(spaceId)!;
    s.seq = seq;
    s.events = [];
    s.minSeq = 0n;
  }
  /** Writes an entity as if a member had pushed it (any type, schema or data), producing one event. */
  inject(spaceId: string, e: { type: string; id: string; data?: Record<string, unknown>; schema?: number; deleted?: boolean; opId?: string }): EntityJson {
    const s = this.spaces.get(spaceId)!;
    const key = `${e.type}/${e.id}`;
    const cur = s.entities.get(key);
    s.seq += 1n;
    const opId = e.opId ?? `inj-${spaceId}-${s.seq}`;
    const next: EntityJson = { schema: e.schema ?? 1, type: e.type, id: e.id, version: (cur?.version ?? 0) + 1, deleted: !!e.deleted, appliedOps: [...(cur?.appliedOps ?? []), opId].slice(-50), updatedAt: new Date().toISOString(), updatedBy: { id: "0", login: "injected" }, data: e.deleted ? {} : (e.data ?? {}) };
    s.entities.set(key, next);
    s.events.push({ seq: s.seq, opId, entity: next });
    return next;
  }
  /** Removes an entity from the current state without leaving a tombstone event (history pruning). */
  dropEntity(spaceId: string, type: string, id: string) {
    this.spaces.get(spaceId)?.entities.delete(`${type}/${id}`);
  }
  /** Every push touching this entity answers stale, and the entity is bumped so a retry on the fresh version is stale again. */
  alwaysStale(spaceId: string, type: string, id: string) {
    this.stale.add(`${spaceId}/${type}/${id}`);
  }
  dropNextResponse() {
    this.dropNext = true;
  }
  entity(spaceId: string, type: string, id: string) {
    return this.spaces.get(spaceId)?.entities.get(`${type}/${id}`);
  }
  seq(spaceId: string) {
    return this.spaces.get(spaceId)!.seq;
  }
  pruneBefore(seq: bigint) {
    for (const s of this.spaces.values()) {
      s.events = s.events.filter((e) => e.seq >= seq);
      s.minSeq = seq;
    }
  }
  removeMember(githubId: string) {
    const m = this.members.get(githubId);
    if (m) m.status = "REMOVED";
    for (const s of [...this.sockets]) {
      if (s.member?.githubId !== githubId) continue;
      s.deliver({ t: "bye", reason: "removed" });
      s.deliverClose(4403);
    }
  }
  deleteSpace(id: string) {
    const s = this.spaces.get(id);
    if (!s) return;
    this.spaces.delete(id);
    for (const k of this.sockets) if (this.canRead(k.member, s)) k.deliver({ t: "access", spaceId: id, action: "deleted" });
  }
  socket(token: string): FakeSocket {
    const m = this.byToken(token);
    const sock = new FakeSocket(m && m.status === "ACTIVE" ? m : null, this);
    queueMicrotask(() => {
      if (!sock.member) return sock.deliverClose(4401);
      this.sockets.add(sock);
      sock.onopen?.();
      sock.deliver({ t: "hello", spaces: this.visible(sock.member).map((s) => ({ id: s.id, seq: String(s.seq) })) });
    });
    return sock;
  }

  private byToken(token: string | null) {
    const id = token?.startsWith("tok-") ? token.slice(4) : null;
    return id && !this.revoked.has(id) ? (this.members.get(id) ?? null) : null;
  }
  private canRead(m: Member | null, s: Space) {
    return !!m && m.status === "ACTIVE" && (s.kind === "COMMON" || s.members.has(m.githubId));
  }
  private visible(m: Member) {
    return [...this.spaces.values()].filter((s) => this.canRead(m, s));
  }
  // Coalesce `changed` per space over 100 ms.
  private notify(s: Space) {
    const p = this.pending.get(s.id);
    if (p) {
      p.seq = s.seq;
      return;
    }
    const timer = setTimeout(() => {
      const seq = this.pending.get(s.id)!.seq;
      this.pending.delete(s.id);
      for (const k of this.sockets) if (this.canRead(k.member, s)) k.deliver({ t: "changed", spaceId: s.id, seq: String(seq) });
    }, 100);
    this.pending.set(s.id, { seq: s.seq, timer });
  }

  private applyOps(s: Space, actor: Member, ops: Op[]): OpResult[] {
    return ops.map((op): OpResult => {
      const key = `${op.type}/${op.entityId}`;
      const cur = s.entities.get(key);
      const seen = cur && (cur.appliedOps.includes(op.opId) || s.events.some((e) => e.opId === op.opId && e.entity.type === op.type && e.entity.id === op.entityId));
      if (cur && seen) return { opId: op.opId, status: "duplicate", version: cur.version };
      if (this.stale.has(`${s.id}/${key}`)) {
        // Somebody else keeps editing this entity: bump it (data unchanged) so every retry is stale again.
        const bumped = this.inject(s.id, { type: op.type, id: op.entityId, data: cur?.data, deleted: cur?.deleted });
        return { opId: op.opId, status: "stale", version: bumped.version, current: bumped };
      }
      if (op.baseVersion !== (cur?.version ?? 0)) return { opId: op.opId, status: "stale", version: cur?.version ?? 0, current: cur };
      const del = op.kind === "DELETE";
      const next: EntityJson = { schema: 1, type: op.type, id: op.entityId, version: (cur?.version ?? 0) + 1, deleted: del, appliedOps: [...(cur?.appliedOps ?? []), op.opId].slice(-50), updatedAt: new Date().toISOString(), updatedBy: { id: actor.githubId, login: actor.login }, data: del ? {} : (op.data ?? {}) };
      s.entities.set(key, next);
      s.seq += 1n;
      s.events.push({ seq: s.seq, opId: op.opId, entity: next });
      return { opId: op.opId, status: "applied", version: next.version };
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (this.failures > 0) {
      this.failures--;
      if (this.failKind === "network") return req.socket.destroy();
      const code = { auth: 401, forbidden: 403, "not-found": 404, "rate-limited": 429, unknown: 500 }[this.failKind];
      res.writeHead(code, { "content-type": "application/json", ...(code === 429 ? { "retry-after": "30" } : {}) });
      return res.end("{}");
    }
    if (url.pathname === "/health") return send(200, { ok: true, team: { name: "Team" }, schema: this.schema, publicUrl: this.publicUrl ?? this.origin(), githubHost: this.githubHost });
    const m = this.byToken(/^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null);
    if (!m) return send(401, { error: "unauthorized" });
    if (m.status !== "ACTIVE") return send(403, { error: "forbidden" });
    if (url.pathname === "/me") {
      const members = [...this.members.values()].map((x) => ({ githubId: x.githubId, login: x.login, name: null, avatarUrl: null, role: x.role, status: x.status }));
      const spaces = this.visible(m).map((s) => ({ id: s.id, kind: s.kind, name: s.name, canWrite: m.role !== "READER", seq: String(s.seq) }));
      return send(200, { member: { githubId: m.githubId, login: m.login, name: null, avatarUrl: null, role: m.role, status: m.status }, team: { id: "team", name: "Team" }, members, spaces, webhooks: this.webhooks });
    }
    const route = /^\/spaces\/([^/]+)\/(entities|snapshot|ops)$/.exec(url.pathname);
    const s = route ? this.spaces.get(decodeURIComponent(route[1])) : undefined;
    if (!route || !s || !this.canRead(m, s)) return send(404, { error: "not found" });
    if (route[2] === "snapshot") return send(200, { seq: String(s.seq), entities: [...s.entities.values()] });
    if (route[2] === "entities") {
      const since = BigInt(url.searchParams.get("since") ?? "0");
      if (since + 1n < s.minSeq && since < s.seq) return send(410, { error: "gone" });
      const newer = s.events.filter((e) => e.seq > since);
      const page = newer.slice(0, 500);
      const events: EventJson[] = page.map((e) => ({ ...e.entity, seq: String(e.seq), opId: e.opId }));
      return send(200, { seq: String(page.length ? page[page.length - 1].seq : s.seq), events, more: newer.length > page.length });
    }
    if (req.method !== "POST") return send(405, { error: "method" });
    this.opsRequests++;
    if (m.role === "READER") return send(403, { error: "read only" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { ops?: Op[] };
    if (!Array.isArray(body.ops)) return send(400, { error: "bad body" });
    const results = this.applyOps(s, m, body.ops);
    if (results.some((r) => r.status === "applied")) this.notify(s);
    if (this.dropNext) {
      this.dropNext = false;
      return req.socket.destroy();
    }
    send(200, { results, seq: String(s.seq) });
  }

  origin() {
    return `http://127.0.0.1:${this.port}`;
  }
  async listen(): Promise<{ url: string }> {
    const server = http.createServer((req, res) => void this.handle(req, res).catch(() => res.destroy()));
    server.on("connection", (c) => {
      this.conns.add(c);
      c.on("close", () => this.conns.delete(c));
    });
    await new Promise<void>((ok) => server.listen(this.port, "127.0.0.1", ok));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return { url: this.origin() };
  }
  async close() {
    for (const s of [...this.sockets]) s.deliverClose(1006);
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    for (const c of this.conns) c.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((ok) => server.close(() => ok()));
  }
  async restart() {
    await this.close();
    await this.listen();
  }
}
