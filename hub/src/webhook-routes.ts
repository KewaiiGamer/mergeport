import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getMember, requireSession, type Member } from "./auth";
import { requireRole } from "./authz";
import { HttpError, json, readJson, readRaw, route, type Route } from "./http";
import type { HubContext } from "./server";

/** Raw body cap. */
export const MAX_WEBHOOK_BODY = 1024 * 1024;
/** Above this the payload is not parsed into the relay (`payload: null`): the app fetches instead. */
export const MAX_RELAY_PAYLOAD = 256 * 1024;
const DEDUPE_MS = 10 * 60 * 1000;
const DEDUPE_MAX = 5000;
/** Bodies being read at once; the next one is refused before its body is read. */
const MAX_INFLIGHT = 16;
const BUCKET = { key: "webhook:github", limit: 600, windowMs: 60_000 };

/** Recorded in the status, never relayed. */
const RECORDED = new Set(["ping", "installation", "installation_repositories"]);
const RELAYED = new Set(["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_run", "check_suite", "status", "push", "create", "delete"]);

const putBody = z.object({
  secret: z.string().min(32).max(256),
  appSlug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/).optional(),
});

const noContent = (res: ServerResponse) => {
  res.writeHead(204);
  res.end();
};

/** Header value as one string, or null when absent or repeated. */
const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
};

function validSignature(secret: string, body: Buffer, sig: string | null): boolean {
  const m = sig === null ? null : /^sha256=([0-9a-fA-F]{64})$/.exec(sig);
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(m[1], "hex"));
}

export function webhookRoutes(): Route<HubContext>[] {
  const owner = (ctx: HubContext, req: IncomingMessage): Member => {
    const s = requireSession(ctx, req);
    requireRole(s.member, "OWNER");
    return s.member;
  };
  /** Delivery id -> time first seen. Insertion order is time order, so the oldest entries are at the front. */
  let inflight = 0;
  const seen = new Map<string, number>();

  return [
    route<HubContext>("PUT", "/admin/github-webhook", async (ctx, req, res) => {
      const first = owner(ctx, req);
      const body = await readJson(req, putBody);
      // The body was awaited since the first check: re-read the actor.
      const actor = getMember(ctx.db, first.githubId);
      if (!actor || actor.status !== "ACTIVE") throw new HttpError(403, "forbidden");
      requireRole(actor, "OWNER");
      ctx.webhooks.set(body.secret, body.appSlug ?? null);
      ctx.log.info("github webhook configured", { member: actor.githubId.toString() });
      noContent(res);
    }),

    route<HubContext>("DELETE", "/admin/github-webhook", (ctx, req, res) => {
      const actor = owner(ctx, req);
      ctx.webhooks.clear();
      ctx.log.info("github webhook removed", { member: actor.githubId.toString() });
      noContent(res);
    }),

    route<HubContext>("POST", "/webhooks/github", async (ctx, req, res) => {
      const secret = ctx.webhooks.secret();
      if (!secret) throw new HttpError(404, "not found");
      if (inflight >= MAX_INFLIGHT) throw new HttpError(503, "busy", { "retry-after": "1", connection: "close" });
      inflight++;
      let raw: Buffer;
      try {
        raw = await readRaw(req, res, MAX_WEBHOOK_BODY);
      } finally {
        inflight--;
      }
      if (!validSignature(secret, raw, header(req, "x-hub-signature-256"))) throw new HttpError(401, "invalid signature");

      const event = header(req, "x-github-event") ?? "";
      if (RECORDED.has(event)) {
        ctx.webhooks.record(event, ctx.now());
        ctx.log.info("github webhook", { event });
        return json(res, 200, { ok: true });
      }
      if (!RELAYED.has(event)) return json(res, 202, { ok: true, ignored: true });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new HttpError(400, "invalid json");
      }
      const repo = (parsed as { repository?: { id?: unknown; private?: unknown; owner?: { login?: unknown; id?: unknown } } } | null)?.repository;
      const id = repo?.id;
      const ownerLogin = repo?.owner?.login;
      const rawOwnerId = repo?.owner?.id;
      const ownerId = typeof rawOwnerId === "number" && Number.isInteger(rawOwnerId) && rawOwnerId >= 0 ? rawOwnerId : null;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || typeof repo?.private !== "boolean" || typeof ownerLogin !== "string") throw new HttpError(400, "invalid payload");

      const delivery = header(req, "x-github-delivery");
      const deliveryId = delivery && /^[A-Za-z0-9_-]{1,100}$/.test(delivery) ? delivery : randomUUID();
      const t = ctx.now();
      for (const [k, at] of seen) {
        if (at > t - DEDUPE_MS && seen.size <= DEDUPE_MAX) break;
        seen.delete(k);
      }
      if (delivery && seen.has(deliveryId)) return json(res, 200, { ok: true, notified: 0 });

      const taken = ctx.limiter.take(BUCKET.key, BUCKET.limit, BUCKET.windowMs);
      if (!taken.ok) throw new HttpError(429, "rate limited", { "retry-after": String(taken.retryAfterSec) });

      const repoId = String(id);
      const notified = ctx.notify.github({ repoId, isPrivate: repo.private, ownerLogin, ownerId, event, delivery: deliveryId, payload: raw.length > MAX_RELAY_PAYLOAD ? null : parsed });
      // Remembered only after the relay succeeded: a failed one is processed again on redelivery.
      seen.set(deliveryId, t);
      while (seen.size > DEDUPE_MAX) seen.delete(seen.keys().next().value as string);
      ctx.webhooks.record(event, t);
      ctx.log.info("github webhook", { event, repoId, notified });
      json(res, 200, { ok: true, notified });
    }),
  ];
}
