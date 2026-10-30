import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HubConfig } from "./config";
import type { HubDb } from "./db";
import { adminRoutes } from "./admin-routes";
import { authRoutes } from "./auth-routes";
import { createNotifier, type Notifier } from "./notify";
import { findSession, isBootstrapped, requestMembers } from "./auth";
import { createLimiter, type Limiter } from "./ratelimit";
import { entityRoutes, startPruneTimer } from "./entities";
import { HttpError, json, matchRoute, route, type Route } from "./http";
import { createWebhookState, type WebhookState } from "./settings";
import { webhookRoutes } from "./webhook-routes";
import { createLogger, type Logger } from "./log";

export type { Logger };

export type HubContext = {
  config: HubConfig;
  db: HubDb;
  now: () => number;
  log: Logger;
  /** Public base URL: config value, or the listened URL when config leaves it empty. */
  publicUrl: () => string;
  notify: Notifier;
  limiter: Limiter;
  /** GitHub App webhook secret and the last delivery. */
  webhooks: WebhookState;
  /** Fresh per process. A database restored from a backup can only be served by a new process, so clients that see it change compare their state with the hub's. */
  epoch: string;
};

export type Hub = { listen(port?: number): Promise<{ port: number; url: string }>; close(): Promise<void> };

/** Later tasks add their routes here, or pass `routes` to createHub. */
export function coreRoutes(): Route<HubContext>[] {
  return [
    route<HubContext>("GET", "/health", (ctx, _req, res) => {
      const team = ctx.db.prepare("SELECT name FROM team LIMIT 1").get() as { name: string } | undefined;
      json(res, 200, { ok: true, bootstrapped: isBootstrapped(ctx.db), team: team ? { name: team.name } : null, schema: 1, publicUrl: ctx.publicUrl(), githubHost: "github.com" });
    }),
    ...authRoutes(),
    ...adminRoutes(),
    ...entityRoutes(),
    ...webhookRoutes(),
  ];
}

export function createHub(opts: { config: HubConfig; db: HubDb; now?: () => number; log?: Logger; routes?: Route<HubContext>[]; ws?: { silenceMs?: number; coalesceMs?: number } }): Hub {
  let listened = "";
  const now = opts.now ?? Date.now;
  const log = opts.log ?? createLogger();
  const ctx: HubContext = {
    config: opts.config,
    db: opts.db,
    now,
    log,
    publicUrl: () => opts.config.publicUrl || listened,
    limiter: createLimiter(now),
    webhooks: createWebhookState(opts.db, opts.config.githubWebhookSecret),
    epoch: randomUUID(),
    notify: createNotifier({ db: opts.db, now, findSession, ...opts.ws, log }),
  };
  const routes = [...coreRoutes(), ...(opts.routes ?? [])];

  const server = http.createServer((req, res) => {
    const started = performance.now();
    res.on("finish", () => {
      const member = requestMembers.get(req);
      // Method, path (no query), status, duration, member id. Never headers, body or query.
      ctx.log.info("request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started), ...(member === undefined ? {} : { member }) });
    });
    void (async () => {
      try {
        let url: URL;
        try {
          url = new URL(req.url ?? "/", "http://hub.local");
        } catch {
          throw new HttpError(400, "bad path");
        }
        const m = matchRoute(routes, req.method ?? "GET", url.pathname);
        if (!m) throw new HttpError(404, "not found");
        await m.route.handler(ctx, req, res, m.params, url);
      } catch (e) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (e instanceof HttpError) json(res, e.status, { error: e.message }, e.headers);
        else {
          ctx.log.error("unhandled", { method: req.method, path: req.url?.split("?")[0], error: e instanceof Error ? e.message : "unknown error" });
          json(res, 500, { error: "internal" });
        }
      }
    })();
  });

  ctx.notify.attach(server);
  let stopPrune: (() => void) | null = null;

  return {
    listen(port = opts.config.port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, opts.config.bindHost, () => {
          const p = (server.address() as AddressInfo).port;
          listened = `http://127.0.0.1:${p}`;
          stopPrune ??= startPruneTimer(ctx);
          resolve({ port: p, url: listened });
        });
      });
    },
    close() {
      stopPrune?.();
      stopPrune = null;
      return ctx.notify.shutdown().then(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
    },
  };
}
