import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public headers?: Record<string, string>) {
    super(message);
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The whole body as a Buffer, untouched. Past the limit it stops reading at once: 413, and the socket is destroyed once the answer is out (no draining). */
export function readRaw(req: IncomingMessage, res: ServerResponse, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (buf: Buffer) => {
      size += buf.length;
      if (size <= limitBytes) return void chunks.push(buf);
      done();
      // Unread data left in the socket would turn the close into a reset that can swallow the 413: discard briefly, then cut.
      req.resume();
      res.once("finish", () => setTimeout(() => req.destroy(), 250).unref());
      reject(new HttpError(413, "body too large", { connection: "close" }));
    };
    const onEnd = () => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onClose = () => {
      done();
      reject(new HttpError(400, "aborted"));
    };
    const onError = (e: Error) => {
      done();
      reject(e);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

export async function readJson<T>(req: IncomingMessage, schema: ZodType<T>, limitBytes = 1_000_000): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooBig = false;
  // Drain the whole body even when oversized so the 413 reaches the client before the socket closes.
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) tooBig = true;
    if (!tooBig) chunks.push(buf);
  }
  if (tooBig) throw new HttpError(413, "body too large", { connection: "close" });
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "invalid body");
  return parsed.data;
}

export type RouteHandler<C> = (ctx: C, req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => void | Promise<void>;
export type Route<C> = { method: string; keys: string[]; regex: RegExp; handler: RouteHandler<C> };

/** Pattern segments starting with `:` capture one path segment into `params`. */
export function route<C>(method: string, pattern: string, handler: RouteHandler<C>): Route<C> {
  const keys: string[] = [];
  const src = pattern
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, keys, regex: new RegExp(`^${src}/?$`), handler };
}

export function matchRoute<C>(routes: Route<C>[], method: string, pathname: string): { route: Route<C>; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < r.keys.length; i++) {
      try {
        params[r.keys[i]] = decodeURIComponent(m[i + 1]);
      } catch {
        throw new HttpError(400, "bad path");
      }
    }
    return { route: r, params };
  }
  return null;
}
