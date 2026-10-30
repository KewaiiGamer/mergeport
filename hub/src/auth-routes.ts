import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { bootstrapOrAdmit, createSession, getMember, requireSession, revokeSession, toMember, type Member } from "./auth";
import { listSpacesFor } from "./authz";
import { fetchGithubUser, pollDeviceFlow, startDeviceFlow } from "./github-oauth";
import { HttpError, json, readJson, route, type Route } from "./http";
import type { HubContext } from "./server";

export const memberJson = (m: Member) => ({ githubId: m.githubId.toString(), login: m.login, name: m.name, avatarUrl: m.avatarUrl, role: m.role, status: m.status });

function teamJson(ctx: HubContext): { id: string; name: string } {
  const t = ctx.db.prepare("SELECT id, name FROM team LIMIT 1").get() as { id: string; name: string } | undefined;
  if (!t) throw new HttpError(500, "no team");
  return t;
}

/**
 * Behind a trusted proxy, the RIGHTMOST X-Forwarded-For entry: that is the address the proxy itself saw, while anything
 * to its left was sent by the client and can be anything. Otherwise the socket address.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const entries = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").map((e) => e.trim()).filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function authRoutes(): Route<HubContext>[] {
  /**
   * Device flows this hub started, keyed by GitHub's device code. Only the caller that started a flow holds its poll
   * secret, so a device code seen on the wire (a log, a shoulder) is not enough to collect the session. Kept in memory:
   * a restart ends the flows, and the person starts again.
   */
  const flows = new Map<string, { secretHash: Buffer; expiresAt: number; final?: { status: number; body: unknown } }>();
  /** A finished flow answers the same way for this long, so a client whose reply was lost (a timeout) can ask again and still get its session. */
  const FINAL_GRACE_MS = 60_000;
  const sweep = (now: number) => {
    for (const [k, f] of flows) if (f.expiresAt <= now) flows.delete(k);
  };
  return [
    route<HubContext>("POST", "/auth/device/start", async (ctx, req, res) => {
      const taken = ctx.limiter.take(`device:${clientIp(req, ctx.config.trustProxy)}`, 10, 60_000);
      if (!taken.ok) throw new HttpError(429, "rate limited", { "retry-after": String(taken.retryAfterSec) });
      const started = await startDeviceFlow(ctx.config);
      const pollSecret = randomBytes(32).toString("base64url");
      sweep(ctx.now());
      flows.set(started.deviceCode, { secretHash: sha256(pollSecret), expiresAt: ctx.now() + started.expiresIn * 1000 });
      json(res, 200, { ...started, pollSecret });
    }),
    route<HubContext>("POST", "/auth/device/poll", async (ctx, req, res) => {
      const taken = ctx.limiter.take(`device-poll:${clientIp(req, ctx.config.trustProxy)}`, 30, 60_000);
      if (!taken.ok) throw new HttpError(429, "rate limited", { "retry-after": String(taken.retryAfterSec) });
      const { deviceCode, pollSecret } = await readJson(req, z.object({ deviceCode: z.string().min(1).max(256), pollSecret: z.string().min(1).max(256) }));
      sweep(ctx.now());
      const flow = flows.get(deviceCode);
      // Unknown code and wrong secret are the same answer: nothing confirms that a device code exists.
      if (!flow || !timingSafeEqual(flow.secretHash, sha256(pollSecret))) throw new HttpError(404, "unknown device code");
      const settled = () => flow.final;
      let done = settled();
      if (done) return json(res, done.status, done.body);
      const polled = await pollDeviceFlow(ctx.config, deviceCode);
      done = settled(); // a concurrent poll may have finished the flow while this one waited on GitHub
      if (done) return json(res, done.status, done.body);
      if (polled.kind === "pending") return json(res, 202, { pending: true });
      if (polled.kind === "slow_down") return json(res, 202, { pending: true, slowDown: true });
      const finish = (status: number, body: unknown) => {
        flow.final = { status, body };
        flow.expiresAt = ctx.now() + FINAL_GRACE_MS;
        json(res, status, body);
      };
      if (polled.kind === "expired") return finish(410, { error: "expired" });
      if (polled.kind === "denied") return finish(403, { reason: "denied" });
      // The GitHub access token is used for this one lookup, then dropped.
      const user = await fetchGithubUser(ctx.config, polled.accessToken);
      const admission = bootstrapOrAdmit(ctx.db, user, ctx.now(), ctx.config.ownerLogin);
      if (!admission.ok) {
        ctx.log.info("sign-in refused", { githubId: user.id, login: user.login, reason: admission.reason });
        return finish(403, { reason: admission.reason });
      }
      const clientName = (req.headers["x-mergeport-client"] as string | undefined)?.slice(0, 100) ?? null;
      const session = createSession(ctx.db, admission.member.githubId, clientName, ctx.now());
      if (admission.joined) ctx.notify.team("member");
      ctx.log.info("sign-in", { githubId: user.id, login: user.login, role: admission.member.role });
      finish(200, { session, member: memberJson(admission.member), team: teamJson(ctx) });
    }),
    route<HubContext>("POST", "/auth/logout", (ctx, req, res) => {
      const s = requireSession(ctx, req);
      revokeSession(ctx.db, s.idHash);
      ctx.notify.dropSession(s.idHash);
      res.writeHead(204);
      res.end();
    }),
    route<HubContext>("GET", "/me", (ctx, req, res) => {
      const s = requireSession(ctx, req);
      const rows = ctx.db.prepare("SELECT * FROM member WHERE status = 'ACTIVE' ORDER BY joined_at, github_id").safeIntegers(true).all() as Parameters<typeof toMember>[0][];
      const self = getMember(ctx.db, s.githubId) ?? s.member;
      json(res, 200, { member: memberJson(self), team: teamJson(ctx), members: rows.map((r) => memberJson(toMember(r))), spaces: listSpacesFor(ctx.db, self), webhooks: ctx.webhooks.status() });
    }),
  ];
}
