import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import type { HubConfig } from "../../hub/src/config";
import { openHubDb, type HubDb } from "../../hub/src/db";
import { createLogger } from "../../hub/src/log";
import { createHub } from "../../hub/src/server";

export type FakeUser = { id: bigint; login: string; name?: string; avatarUrl?: string };
type DeviceGrant = { deviceCode: string; userCode: string; state: "pending" | "slow_down" | "approved" | "denied" | "expired"; userId?: bigint; token?: string };

/** Stand-in for github.com device flow + api.github.com/user. Reusable by auth tests. */
export class FakeGitHubOAuth {
  readonly server = http.createServer((req, res) => void this.handle(req, res));
  readonly users = new Map<bigint, FakeUser>();
  readonly grants: DeviceGrant[] = [];
  /** access token -> user id */
  readonly tokens = new Map<string, bigint>();
  readonly requests: { method: string; path: string; body: Record<string, string> }[] = [];
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  close(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }
  addUser(u: FakeUser): void {
    this.users.set(u.id, u);
  }
  private byUserCode(userCode: string): DeviceGrant {
    const g = this.grants.find((x) => x.userCode === userCode);
    if (!g) throw new Error(`unknown user code ${userCode}`);
    return g;
  }
  authorize(userCode: string, userId: bigint): void {
    const g = this.byUserCode(userCode);
    g.state = "approved";
    g.userId = userId;
  }
  deny(userCode: string): void {
    this.byUserCode(userCode).state = "denied";
  }
  expire(userCode: string): void {
    this.byUserCode(userCode).state = "expired";
  }
  /** GitHub asks the poller to back off (it keeps answering slow_down until the grant changes state). */
  slowDown(userCode: string): void {
    this.byUserCode(userCode).state = "slow_down";
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, string> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    this.requests.push({ method: req.method ?? "", path: pathname, body });
    const send = (status: number, payload: unknown) => {
      const t = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(t) });
      res.end(t);
    };

    if (req.method === "POST" && pathname === "/login/device/code") {
      const g: DeviceGrant = {
        deviceCode: randomBytes(20).toString("hex"),
        userCode: randomBytes(4).toString("hex").toUpperCase().replace(/(.{4})/, "$1-"),
        state: "pending",
      };
      this.grants.push(g);
      return send(200, { device_code: g.deviceCode, user_code: g.userCode, verification_uri: `${this.url}/login/device`, expires_in: 900, interval: 5 });
    }
    if (req.method === "POST" && pathname === "/login/oauth/access_token") {
      const g = this.grants.find((x) => x.deviceCode === body.device_code);
      if (!g) return send(200, { error: "bad_verification_code" });
      if (g.state === "pending") return send(200, { error: "authorization_pending" });
      if (g.state === "slow_down") return send(200, { error: "slow_down" });
      if (g.state === "denied") return send(200, { error: "access_denied" });
      if (g.state === "expired") return send(200, { error: "expired_token" });
      g.token ??= `gho_${randomBytes(16).toString("hex")}`;
      this.tokens.set(g.token, g.userId!);
      return send(200, { access_token: g.token, token_type: "bearer", scope: "" });
    }
    if (req.method === "GET" && pathname === "/user") {
      const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? /^token (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      const id = token ? this.tokens.get(token) : undefined;
      const u = id === undefined ? undefined : this.users.get(id);
      if (!u) return send(401, { message: "Bad credentials" });
      // GitHub ids can exceed 2^53 in theory; emit as a JSON number from the bigint literal.
      const text = `{"id":${u.id},"login":${JSON.stringify(u.login)},"name":${JSON.stringify(u.name ?? null)},"avatar_url":${JSON.stringify(u.avatarUrl ?? null)}}`;
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      return void res.end(text);
    }
    const userByLogin = /^\/users\/([^/]+)$/.exec(pathname);
    if (req.method === "GET" && userByLogin) {
      // api.github.com/users/{login}: public profile; the hub sends the OAuth App's Basic credentials, anything else is refused.
      const auth = req.headers.authorization ?? "";
      if (auth !== `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`) return send(401, { message: "Bad credentials" });
      const login = decodeURIComponent(userByLogin[1]).toLowerCase();
      const u = [...this.users.values()].find((x) => x.login.toLowerCase() === login);
      if (!u) return send(404, { message: "Not Found" });
      const text = `{"id":${u.id},"login":${JSON.stringify(u.login)},"name":${JSON.stringify(u.name ?? null)},"avatar_url":${JSON.stringify(u.avatarUrl ?? null)}}`;
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      return void res.end(text);
    }
    send(404, { message: "Not Found" });
  }
}

export type ApiResult = { status: number; body: any; headers: Headers };
export type TestHub = {
  url: string;
  dataDir: string;
  db: HubDb;
  /** Captured log lines. */
  logs: string[];
  github: FakeGitHubOAuth;
  close(): Promise<void>;
  api(token?: string): (method: string, path: string, body?: unknown) => Promise<ApiResult>;
};

export async function startTestHub(o: { now?: () => number; dataDir?: string; /** Fixed port (a hub restarted on the address its clients already know). */ port?: number; trustProxy?: boolean; /** Login allowed to bootstrap the empty hub; default `olive`. */ ownerLogin?: string; ws?: { silenceMs?: number; coalesceMs?: number }; /** MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET fallback. */ webhookSecretEnv?: string } = {}): Promise<TestHub> {
  const github = new FakeGitHubOAuth();
  await github.start();
  const dataDir = o.dataDir ?? mkdtempSync(path.join(tmpdir(), "hub-"));
  const config: HubConfig = {
    port: 0,
    dataDir,
    publicUrl: "",
    githubClientId: "test-client",
    githubClientSecret: "test-secret",
    ownerLogin: o.ownerLogin ?? "olive",
    trustProxy: o.trustProxy ?? true,
    githubApiBase: github.url,
    githubOauthBase: github.url,
    bindHost: "127.0.0.1",
    githubWebhookSecret: o.webhookSecretEnv,
  };
  const db = openHubDb(dataDir);
  const logs: string[] = [];
  const hub = createHub({ config, db, now: o.now, ws: o.ws, log: createLogger((l) => logs.push(l)) });
  const { url } = await hub.listen(o.port ?? 0);
  return {
    url,
    dataDir,
    db,
    logs,
    github,
    async close() {
      await hub.close();
      db.close();
      await github.close();
    },
    api(token) {
      return async (method, p, body) => {
        const headers: Record<string, string> = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        const r = await fetch(url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await r.text();
        let parsed: any = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          /* keep text */
        }
        return { status: r.status, body: parsed, headers: r.headers };
      };
    },
  };
}

/** X-Hub-Signature-256 value for a body, as GitHub computes it. */
export const signBody = (secret: string, body: string | Buffer): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

let deliverySeq = 0;
/** A repository object as GitHub puts it in every webhook payload. */
export const ghRepo = (id: number, owner: string, isPrivate = false) => ({ id, private: isPrivate, owner: { login: owner }, full_name: `${owner}/repo${id}` });

/** Posts a delivery to /webhooks/github, signed with `secret` unless `signature` overrides it (null sends none). `payload` may be a ready string. */
export async function deliver(
  hub: TestHub,
  secret: string,
  event: string,
  payload: unknown,
  o: { delivery?: string; signature?: string | null; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": o.delivery ?? `d-${++deliverySeq}`, ...o.headers };
  const sig = o.signature === undefined ? signBody(secret, body) : o.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  const r = await fetch(hub.url + "/webhooks/github", { method: "POST", headers, body });
  const text = await r.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed, headers: r.headers };
}

/** Adds the fake GitHub user (if absent) and completes a device-flow sign-in; returns the session token. */
export async function signInAs(hub: TestHub, id: bigint, login: string): Promise<string> {
  if (!hub.github.users.has(id)) hub.github.addUser({ id, login });
  const s = (await hub.api()("POST", "/auth/device/start")).body as { deviceCode: string; userCode: string; pollSecret: string };
  hub.github.authorize(s.userCode, id);
  const r = await hub.api()("POST", "/auth/device/poll", { deviceCode: s.deviceCode, pollSecret: s.pollSecret });
  if (r.status !== 200) throw new Error(`sign-in of ${login} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.session as string;
}
