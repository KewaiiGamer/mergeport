/** Live link to the hub: one WebSocket with backoff, ping and per-space debounce of `changed`. The token only travels in the subprotocol list, never in the URL. */

export interface SocketLike {
  onopen: ((e?: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: { code: number }) => void) | null;
  onerror: ((e?: unknown) => void) | null;
  send(data: string): void;
  close(code?: number): void;
}

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type HubLinkState = "live" | "reconnecting" | "offline" | "signed-out" | "removed";

export const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export type HubLinkOptions = {
  origin: string;
  getToken: () => Promise<string | null>;
  connect?: (url: string, protocols: string[]) => SocketLike;
  timers?: Timers;
  random?: () => number;
  onChanged(spaceId: string, seq: bigint): void;
  onAccess(spaceId: string, action: "added" | "removed" | "deleted"): void;
  onTeam(reason: "member" | "role"): void;
  onHello?(spaces: { id: string; seq: bigint }[]): void;
  /** A GitHub webhook delivery relayed by the hub. `payload` is null when the hub did not send it (too large). */
  onGithubEvent?(e: { repoId: string; event: string; delivery: string; payload: unknown | null }): void;
  onState?(s: HubLinkState): void;
};

const PING_MS = 25_000;
const DEBOUNCE_MS = 100;
const MAX_BACKOFF_MS = 30_000;
/** Consecutive failed attempts after which the state reads "offline" instead of "reconnecting". */
const OFFLINE_AFTER = 3;

const defaultConnect = (url: string, protocols: string[]): SocketLike => new WebSocket(url, protocols) as unknown as SocketLike;

export class HubLink {
  private _state: HubLinkState = "offline";
  private running = false;
  private gen = 0;
  private sock: SocketLike | null = null;
  private failures = 0;
  private retry: unknown = null;
  private ping: unknown = null;
  private helloed = false;
  private debounce = new Map<string, { seq: bigint; timer: unknown }>();
  private readonly timers: Timers;
  private readonly random: () => number;

  constructor(private readonly o: HubLinkOptions) {
    this.timers = o.timers ?? defaultTimers;
    this.random = o.random ?? Math.random;
  }

  get state(): HubLinkState {
    return this._state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.open();
  }

  stop(): void {
    this.running = false;
    this.gen++;
    this.clearTimers();
    this.dropSocket();
    this._state = "offline";
  }

  /** True once the current socket has received `hello` (cleared on close): `watch` sends only then. After every `hello` the owner sends its set again. */
  get isOpen(): boolean {
    return this.sock !== null && this.helloed;
  }

  /** Replaces the set of GitHub repositories (decimal ids) this connection wants relays for. Nothing is sent while the socket is closed. */
  watch(repoIds: string[]): void {
    const s = this.sock;
    if (!s || !this.helloed) return;
    try {
      s.send(JSON.stringify({ t: "watch", repos: repoIds }));
    } catch {
      // a dead socket reports itself through onclose; the next hello sends the set again
    }
  }

  private setState(s: HubLinkState) {
    if (this._state === s) return;
    this._state = s;
    this.o.onState?.(s);
  }

  private url() {
    return `${this.o.origin.replace(/\/+$/, "").replace(/^http/i, "ws")}/ws`;
  }

  private async open(): Promise<void> {
    const gen = ++this.gen;
    this.setState(this.failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
    let token: string | null;
    try {
      token = await this.o.getToken();
    } catch {
      if (gen === this.gen && this.running) this.scheduleRetry();
      return;
    }
    if (gen !== this.gen || !this.running) return;
    if (!token) {
      this.setState("signed-out");
      return;
    }
    let s: SocketLike;
    try {
      s = (this.o.connect ?? defaultConnect)(this.url(), ["mergeport.v1", `bearer.${token}`]);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.sock = s;
    this.helloed = false;
    s.onopen = () => {
      if (this.sock !== s) return;
      this.ping = this.timers.setInterval(() => {
        try {
          s.send(JSON.stringify({ t: "ping" }));
        } catch {
          // a dead socket reports itself through onclose
        }
      }, PING_MS);
    };
    s.onmessage = (e) => {
      if (this.sock === s) this.message(e.data);
    };
    s.onerror = () => {};
    s.onclose = (e) => {
      if (this.sock !== s) return;
      this.sock = null;
      this.helloed = false;
      this.closed(e.code);
    };
  }

  private message(raw: string) {
    let m: { t?: string; [k: string]: unknown };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      this.dispatch(m);
    } catch {
      // a malformed message is ignored, it must never throw out of onmessage
    }
  }

  private dispatch(m: { t?: string; [k: string]: unknown }) {
    switch (m.t) {
      case "hello": {
        this.helloed = true;
        this.failures = 0;
        this.setState("live");
        const spaces = Array.isArray(m.spaces) ? (m.spaces as { id: string; seq: string | number }[]).map((s) => ({ id: String(s.id), seq: BigInt(s.seq) })) : [];
        this.o.onHello?.(spaces);
        break;
      }
      case "changed":
        this.changed(String(m.spaceId), BigInt(m.seq as string | number));
        break;
      case "gh": {
        const { repoId, event, delivery } = m;
        if (typeof repoId !== "string" || typeof event !== "string" || typeof delivery !== "string") break;
        this.o.onGithubEvent?.({ repoId, event, delivery, payload: m.payload === undefined ? null : m.payload });
        break;
      }
      case "access":
        this.o.onAccess(String(m.spaceId), m.action as "added" | "removed" | "deleted");
        break;
      case "team":
        this.o.onTeam(m.reason as "member" | "role");
        break;
      case "bye":
        this.dropSocket();
        // A server shutdown is an ordinary drop: reconnect. Anything else means this member was removed.
        if (m.reason === "shutdown") this.closed(1001);
        else this.removed();
        break;
    }
  }

  /** A burst of `changed` for one space inside the window becomes one callback carrying the highest seq. */
  private changed(spaceId: string, seq: bigint) {
    const cur = this.debounce.get(spaceId);
    if (cur) {
      if (seq > cur.seq) cur.seq = seq;
      return;
    }
    const entry = { seq, timer: null as unknown };
    entry.timer = this.timers.setTimeout(() => {
      this.debounce.delete(spaceId);
      this.o.onChanged(spaceId, entry.seq);
    }, DEBOUNCE_MS);
    this.debounce.set(spaceId, entry);
  }

  private closed(code: number) {
    this.clearPing();
    if (!this.running) return;
    if (code === 4403) this.removed();
    else this.scheduleRetry();
  }

  private removed() {
    this.gen++;
    this.clearTimers();
    this.setState("removed");
  }

  private scheduleRetry() {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(this.failures, 20) * (0.5 + this.random()));
    this.failures++;
    this.setState(this.failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
    if (this.retry !== null) this.timers.clearTimeout(this.retry);
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      if (this.running) void this.open();
    }, delay);
  }

  private dropSocket() {
    const s = this.sock;
    this.sock = null;
    this.helloed = false;
    this.clearPing();
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close();
    } catch {
      // already closed
    }
  }

  private clearPing() {
    if (this.ping !== null) this.timers.clearInterval(this.ping);
    this.ping = null;
  }

  private clearTimers() {
    this.clearPing();
    if (this.retry !== null) this.timers.clearTimeout(this.retry);
    this.retry = null;
    for (const d of this.debounce.values()) this.timers.clearTimeout(d.timer);
    this.debounce.clear();
  }
}
