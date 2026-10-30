import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { getMember, peekSession, type findSession as findSessionFn, type Member } from "./auth";
import { listSpacesFor, spaceAccess } from "./authz";
import type { HubDb } from "./db";

/** A socket with no message for this long is terminated; clients ping every 25 s. */
export const WS_SILENCE_MS = 75_000;
/** Notifications for one space are merged into one message per this window. */
export const WS_COALESCE_MS = 100;
/** After `bye`, how long a peer gets to answer the close handshake before the socket is cut. */
const CLOSE_GRACE_MS = 1000;
const PROTOCOL = "mergeport.v1";
const TOKEN = /^[A-Za-z0-9_-]{1,200}$/;

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REMOVED = 4403;

export type AccessAction = "added" | "removed" | "deleted";
export type NotifierDeps = {
  db: HubDb;
  now: () => number;
  findSession: typeof findSessionFn;
  silenceMs?: number;
  coalesceMs?: number;
  /** Socket lifecycle lines (member id, close code, recipient count; never tokens or message bodies). */
  log?: { info(msg: string, fields?: Record<string, unknown>): void };
};
export type Notifier = {
  attach(server: http.Server): void;
  /** Queues a `changed` for the space; sent after the coalescing window to sockets whose member can read it. */
  changed(spaceId: string, seq: bigint): void;
  /** `target` is one member's github id, or `"space:" + spaceId` for everyone who can read that space now. */
  access(target: bigint | `space:${string}`, spaceId: string, action: AccessAction): void;
  team(reason: "member" | "role"): void;
  /** Sends `bye` and closes with 4403. */
  kick(githubId: bigint, reason: "removed"): void;
  /** Closes the sockets that belong to this session (logout). */
  dropSession(idHash: string): void;
  /** `bye shutdown`, close 1001, clear every timer; resolves once all sockets are gone. */
  shutdown(): Promise<void>;
};

type Conn = { ws: WebSocket; token: string; idHash: string; githubId: bigint; silence: NodeJS.Timeout | null; grace: NodeJS.Timeout | null };

const reject = (socket: Duplex, status: number, text: string) => {
  const body = `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`;
  socket.once("error", () => socket.destroy());
  socket.write(body, () => socket.destroy());
};

/** Bearer token from `Sec-WebSocket-Protocol: mergeport.v1, bearer.<token>`; null unless both are offered. */
function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const offered = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",").map((s) => s.trim());
  if (!offered.includes(PROTOCOL)) return null;
  const bearer = offered.find((s) => s.startsWith("bearer."));
  const token = bearer?.slice("bearer.".length) ?? "";
  return TOKEN.test(token) ? token : null;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const silenceMs = deps.silenceMs ?? WS_SILENCE_MS;
  const coalesceMs = deps.coalesceMs ?? WS_COALESCE_MS;
  const conns = new Set<Conn>();
  const pending = new Map<string, { seq: bigint; timer: NodeJS.Timeout }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, handleProtocols: () => PROTOCOL });
  const detach: (() => void)[] = [];
  let closing = false;

  const send = (c: Conn, msg: Record<string, unknown>) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  };
  const closeConn = (c: Conn, code: number, bye?: "removed" | "shutdown") => {
    if (bye) send(c, { t: "bye", reason: bye });
    if (c.silence) clearTimeout(c.silence);
    c.silence = null;
    if (c.ws.readyState === c.ws.OPEN || c.ws.readyState === c.ws.CONNECTING) {
      c.ws.close(code, bye ?? "unauthorized");
      c.grace ??= setTimeout(() => c.ws.terminate(), CLOSE_GRACE_MS);
      c.grace.unref();
    }
  };

  /** The session must still exist and its member must be ACTIVE; otherwise the socket is closed. Only a client ping (`slide`) extends the session. */
  const authenticate = (c: Conn, slide = false): Member | null => {
    const s = slide ? deps.findSession(deps.db, c.token, deps.now()) : peekSession(deps.db, c.token, deps.now());
    if (!s) return void closeConn(c, CLOSE_UNAUTHORIZED), null;
    const m = getMember(deps.db, s.githubId);
    if (!m) return void closeConn(c, CLOSE_UNAUTHORIZED), null;
    if (m.status !== "ACTIVE") return void closeConn(c, CLOSE_REMOVED, "removed"), null;
    return m;
  };

  const armSilence = (c: Conn) => {
    if (c.silence) clearTimeout(c.silence);
    c.silence = setTimeout(() => c.ws.terminate(), silenceMs);
    c.silence.unref();
  };

  const flush = (spaceId: string) => {
    const p = pending.get(spaceId);
    pending.delete(spaceId);
    if (!p) return;
    let sent = 0;
    for (const c of [...conns]) {
      const m = authenticate(c);
      if (m && spaceAccess(deps.db, m, spaceId).canRead) {
        send(c, { t: "changed", spaceId, seq: p.seq.toString() });
        sent++;
      }
    }
    deps.log?.info("ws changed", { spaceId, seq: p.seq.toString(), sockets: conns.size, sent });
  };

  const onUpgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://hub.local").pathname;
    } catch {
      return reject(socket, 400, "Bad Request");
    }
    if (pathname !== "/ws") return reject(socket, 404, "Not Found");
    if (closing) return reject(socket, 503, "Service Unavailable");
    const token = tokenFromProtocols(req.headers["sec-websocket-protocol"]);
    const session = token ? deps.findSession(deps.db, token, deps.now()) : null;
    if (!token || !session) return reject(socket, 401, "Unauthorized");
    const member = getMember(deps.db, session.githubId);
    if (!member) return reject(socket, 401, "Unauthorized");
    if (member.status !== "ACTIVE") {
      // A refused upgrade (HTTP 403) reaches the browser as a bare 1006, which looks like any network failure. Accept, say
      // why, and close as kick() does, so the client learns it was removed instead of reconnecting forever.
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => ws.terminate());
        closeConn({ ws, token, idHash: session.idHash, githubId: member.githubId, silence: null, grace: null }, CLOSE_REMOVED, "removed");
      });
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c: Conn = { ws, token, idHash: session.idHash, githubId: member.githubId, silence: null, grace: null };
      conns.add(c);
      armSilence(c);
      deps.log?.info("ws open", { member: member.githubId.toString(), sockets: conns.size });
      ws.on("error", () => ws.terminate());
      ws.on("close", (code) => {
        deps.log?.info("ws close", { member: member.githubId.toString(), closedWith: code, sockets: conns.size - 1 });
        conns.delete(c);
        if (c.silence) clearTimeout(c.silence);
        if (c.grace) clearTimeout(c.grace);
      });
      ws.on("message", (raw, isBinary) => {
        armSilence(c);
        const m = authenticate(c, true);
        if (!m || isBinary) return;
        try {
          const msg = JSON.parse(raw.toString()) as { t?: unknown };
          if (msg.t === "ping") send(c, { t: "pong" });
        } catch {
          /* ignore garbage */
        }
      });
      send(c, { t: "hello", spaces: listSpacesFor(deps.db, member).map((s) => ({ id: s.id, seq: String(s.seq) })) });
    });
  };

  return {
    attach(server) {
      server.on("upgrade", onUpgrade);
      detach.push(() => server.off("upgrade", onUpgrade));
    },
    changed(spaceId, seq) {
      const cur = pending.get(spaceId);
      if (cur) {
        if (seq > cur.seq) cur.seq = seq;
        return;
      }
      const timer = setTimeout(() => flush(spaceId), coalesceMs);
      timer.unref();
      pending.set(spaceId, { seq, timer });
    },
    access(target, spaceId, action) {
      for (const c of conns) {
        if (typeof target === "bigint") {
          if (c.githubId !== target) continue;
        } else {
          const m = getMember(deps.db, c.githubId);
          if (!m || !spaceAccess(deps.db, m, target.slice("space:".length)).canRead) continue;
        }
        send(c, { t: "access", spaceId, action });
      }
    },
    team(reason) {
      for (const c of conns) send(c, { t: "team", reason });
    },
    kick(githubId, reason) {
      for (const c of conns) if (c.githubId === githubId) closeConn(c, CLOSE_REMOVED, reason);
    },
    dropSession(idHash) {
      for (const c of conns) if (c.idHash === idHash) closeConn(c, CLOSE_UNAUTHORIZED);
    },
    async shutdown() {
      closing = true;
      for (const d of detach.splice(0)) d();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      const open = [...conns];
      const done = Promise.all(open.map((c) => new Promise<void>((r) => (c.ws.readyState === c.ws.CLOSED ? r() : c.ws.once("close", () => r())))));
      for (const c of open) closeConn(c, 1001, "shutdown");
      await done;
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
