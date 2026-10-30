import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test double for a Mergeport hub on loopback: /health, the device-flow endpoints, /me and /admin/* with the spec's role rules.
 * It never logs; every request is recorded so tests can assert on what the client sent.
 */
export type FakeHubOpts = {
  publicUrl?: string;
  githubHost?: string;
  team?: string | null;
  invited?: boolean;
  removed?: boolean;
  expired?: boolean;
  pollsBeforeOk?: number;
  /** The first N polls answer 202 with slowDown: true (before pollsBeforeOk's plain pending answers). */
  slowDownPolls?: number;
  githubId?: string;
  login?: string;
  verificationUri?: string;
  members?: FakeMember[];
  spaces?: { id: string; kind: "COMMON" | "RESTRICTED"; name: string; canWrite: boolean; seq: string }[];
  /** Members of each space, answered by GET /admin/spaces. */
  spaceMembers?: Record<string, { githubId: string; canWrite: boolean }[]>;
  /** What GET /me answers under `webhooks` (default: not set up). */
  webhooks?: { enabled: boolean; appSlug: string | null; lastDeliveryAt: string | null; lastEvent: string | null };
  /** Answer every authenticated request with this status (e.g. 401, 403, 429). */
  forceStatus?: number;
};
export type FakeMember = { githubId: string; login: string; name?: string | null; avatarUrl?: string | null; role: "OWNER" | "ADMIN" | "MEMBER" | "READER"; status?: "INVITED" | "ACTIVE" | "REMOVED" };
export const FAKE_SESSION = "session-token-secret";
export const FAKE_DEVICE_CODE = "dev-code-secret";
export const FAKE_POLL_SECRET = "poll-secret-secret";
export type FakeHubRequest = { method: string; path: string; body: unknown };

export async function startFakeHub(opts: FakeHubOpts = {}) {
  const requests: FakeHubRequest[] = [];
  let polls = 0;
  let origin = "";
  const members: FakeMember[] = opts.members ?? [{ githubId: opts.githubId ?? "1", login: opts.login ?? "octocat", role: "OWNER" }];
  const spaces = opts.spaces ?? [{ id: "common", kind: "COMMON", name: "Common", canWrite: true, seq: "0" }];
  const full = (m: FakeMember) => ({ githubId: m.githubId, login: m.login, name: m.name ?? null, avatarUrl: m.avatarUrl ?? null, role: m.role, status: m.status ?? "ACTIVE" });
  const team = opts.team === undefined ? "Fake Team" : opts.team;
  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const p = (req.url ?? "").split("?")[0];
      requests.push({ method: req.method ?? "", path: p, body });
      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true, team: team === null ? null : { name: team }, schema: 1, publicUrl: opts.publicUrl ?? origin, githubHost: opts.githubHost ?? "github.com" });
      if (req.method === "POST" && p === "/auth/device/start") return send(res, 200, { deviceCode: FAKE_DEVICE_CODE, pollSecret: FAKE_POLL_SECRET, userCode: "ABCD-1234", verificationUri: opts.verificationUri ?? `${origin}/device`, interval: 1, expiresIn: 600 });
      if (req.method === "POST" && p === "/auth/device/poll") {
        const b = (body ?? {}) as { deviceCode?: unknown; pollSecret?: unknown };
        if (b.deviceCode !== FAKE_DEVICE_CODE || b.pollSecret !== FAKE_POLL_SECRET) return send(res, 404, { error: "unknown device code" });
        if (opts.expired) return send(res, 410);
        if (opts.removed) return send(res, 403, { reason: "removed" });
        if (opts.invited === false) return send(res, 403, { reason: "not-invited" });
        if (polls < (opts.slowDownPolls ?? 0)) return polls++, send(res, 202, { pending: true, slowDown: true });
        if (polls++ < (opts.slowDownPolls ?? 0) + (opts.pollsBeforeOk ?? 0)) return send(res, 202, { pending: true });
        return send(res, 200, { session: FAKE_SESSION, member: { githubId: opts.githubId ?? "1", login: opts.login ?? "octocat" }, team: { name: team ?? "" } });
      }
      const needsAuth = p === "/me" || p === "/auth/logout" || p.startsWith("/admin/");
      if (!needsAuth) return send(res, 404);
      if (req.headers.authorization !== `Bearer ${FAKE_SESSION}`) return send(res, 401);
      if (opts.forceStatus) return opts.forceStatus === 429 ? (res.writeHead(429, { "retry-after": "7" }), res.end()) : send(res, opts.forceStatus);
      const actor = members.find((m) => m.githubId === (opts.githubId ?? "1"));
      if (!actor || actor.status === "REMOVED") return send(res, 403);
      if (req.method === "POST" && p === "/auth/logout") return send(res, 204);
      if (req.method === "GET" && p === "/me") return send(res, 200, { member: full(actor), team: { name: team ?? "" }, members: members.map(full), spaces, webhooks: opts.webhooks ?? { enabled: false, appSlug: null, lastDeliveryAt: null, lastEvent: null } });
      // admin routes: ADMIN or OWNER; only the OWNER touches an ADMIN; the OWNER is untouchable
      if (actor.role !== "OWNER" && actor.role !== "ADMIN") return send(res, 403);
      const b = (body ?? {}) as { githubLogin?: string; role?: FakeMember["role"]; name?: string };
      const mm = /^\/admin\/members\/([^/]+)$/.exec(p);
      if (req.method === "POST" && p === "/admin/invites") {
        if (!b.githubLogin || !b.role || b.role === "OWNER") return send(res, 422);
        if (b.role === "ADMIN" && actor.role !== "OWNER") return send(res, 403);
        members.push({ githubId: String(100 + members.length), login: b.githubLogin, role: b.role, status: "INVITED" });
        return send(res, 201, { invite: { id: "i1", githubLogin: b.githubLogin, role: b.role } });
      }
      if (mm && (req.method === "DELETE" || req.method === "PATCH")) {
        const t = members.find((m) => m.githubId === decodeURIComponent(mm[1]));
        if (!t) return send(res, 404);
        if (t.role === "OWNER") return send(res, 403);
        if ((t.role === "ADMIN" || b.role === "ADMIN") && actor.role !== "OWNER") return send(res, 403);
        if (req.method === "DELETE") t.status = "REMOVED";
        else if (b.role && b.role !== "OWNER") t.role = b.role;
        else return send(res, 422);
        return send(res, 204);
      }
      if (req.method === "GET" && p === "/admin/spaces") return send(res, 200, { spaces: spaces.map((s) => ({ id: s.id, kind: s.kind, name: s.name, members: opts.spaceMembers?.[s.id] ?? [] })) });
      if (req.method === "POST" && p === "/admin/spaces") {
        if (!b.name) return send(res, 422);
        const sp = { id: `s${spaces.length + 1}`, kind: "RESTRICTED" as const, name: b.name, canWrite: true, seq: "0" };
        spaces.push(sp);
        return send(res, 201, { space: { id: sp.id, kind: sp.kind, name: sp.name, members: [] } });
      }
      const sm = /^\/admin\/spaces\/([^/]+)$/.exec(p);
      if (sm && (req.method === "PATCH" || req.method === "DELETE")) {
        const i = spaces.findIndex((x) => x.id === decodeURIComponent(sm[1]));
        if (i < 0 || spaces[i].kind === "COMMON") return send(res, 404);
        if (req.method === "DELETE") spaces.splice(i, 1);
        else if (b.name) spaces[i].name = b.name;
        return send(res, 204);
      }
      send(res, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    members,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
