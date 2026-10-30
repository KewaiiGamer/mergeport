# Hub Service Implementation Plan (plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted Node service (`hub/`) that stores a team's shared Mergeport entities in SQLite, authenticates members through GitHub's OAuth device flow, enforces team and space permissions, accepts idempotent per-entity operations, and pushes change notifications over WebSocket.

**Architecture:** One `node:http` server with a small hand-written router, `ws` for WebSocket, better-sqlite3 opened directly (no Prisma; the app's `applyMigrations(file, dir)` is reused with `hub/migrations`). All state is in `hub.db`; every request is one synchronous SQLite transaction; notifications fire after commit. Tests start a real hub in-process on port 0 against a fake GitHub OAuth server.

**Tech Stack:** Node 24, TypeScript via `tsx`, `node:http`, `ws`, `better-sqlite3`, `zod`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-hub-server-design.md` (sections "The hub service", "Authorization on the hub", "HTTP API", "WebSocket", "Operations"). Plans 2 and 3 cover the client transport and profiles/switching/UI; nothing in this plan touches `src/` except reading `src/lib/db/migrate.ts`.

## Global Constraints

- Node `>=24.0.0 <25`, npm `>=10`; nothing compiled at install (`better-sqlite3` ships prebuilt).
- Hub refuses to start without `MERGEPORT_HUB_GITHUB_CLIENT_ID` and `MERGEPORT_HUB_GITHUB_CLIENT_SECRET`.
- OAuth scope requested: exactly `read:user`.
- Binds `0.0.0.0` only when `MERGEPORT_HUB_TRUST_PROXY=false` **and** `MERGEPORT_HUB_PUBLIC_URL` starts with `https://`; otherwise `127.0.0.1`.
- Session token: 32 random bytes base64url; only its SHA-256 hex is stored. Sliding expiry 30 days.
- Roles `OWNER|ADMIN|MEMBER|READER`; statuses `INVITED|ACTIVE|REMOVED`; space kinds `COMMON|RESTRICTED`.
- `appliedOps` per entity keeps the last 50 op ids.
- Events older than 30 days **and** older than every active session's cursor are pruned; `since` older than retained log answers `410`.
- Notification coalescing 100 ms per space; client ping every 25 s; socket dropped after 75 s silence; removed member closed with code `4403`.
- Rate limits: 60 requests / 10 s per session; 10 device-flow starts / minute per IP; `429` with `Retry-After`.
- Logs never contain tokens, entity data or user codes.
- GitHub numeric ids are 64-bit: JSON carries them as strings, SQLite as INTEGER.
- Migrations: SQL files `hub/migrations/<name>/migration.sql`, applied by `applyMigrations` from `src/lib/db/migrate.ts`, which already refuses a database with unknown migrations.

## Review Focus

1. A request body that is not JSON, or JSON of the wrong shape (`ops` not an array, `baseVersion` a string): expect `400` with a message, never a crash or a half-applied transaction. Pinned in Task 4.
2. Two ops in one request targeting the same entity: expect them applied in order, the second seeing the first's version, or the second `stale`; never a lost update. Pinned in Task 4.
3. A member removed while their WebSocket is open and a push request is in flight: expect the push refused with `403` and the socket closed `4403`; no event written as that actor after removal. Pinned in Task 5.
4. Hub restarted with `hub.db` present: sessions, members and cursors survive; `seq` continues, never restarts at 0 (a client cursor must stay meaningful). Pinned in Task 4.
5. An `Authorization` header that is present but malformed (`Bearer` with no token, `Basic …`): expect `401`, no exception in logs. Pinned in Task 2.

---

## File structure

```
hub/
  src/main.ts            entry: load config, open db, start server, handle SIGTERM
  src/config.ts          zod schema of MERGEPORT_HUB_* env; HubConfig type
  src/db.ts              openHubDb(dataDir) -> better-sqlite3 Database with migrations applied
  src/http.ts            tiny router, json(), readJson(), HttpError, bearer parsing
  src/server.ts          createHub(deps): wires routes + ws, returns { listen, close, address }
  src/github-oauth.ts    device flow calls against a configurable GitHub base URL
  src/auth.ts            sessions (create/lookup/slide/revoke), owner bootstrap, invites
  src/authz.ts           role/space checks: requireMember, requireRole, spaceAccess
  src/entities.ts        ops apply, events since, snapshot, pruning
  src/notify.ts          per-space coalescer, WebSocket registry, access/team fanout
  src/ratelimit.ts       sliding-window counters
  src/log.ts             redacting logger
  migrations/20261030000000_init/migration.sql
  README.md
tests/hub/
  harness.ts             startTestHub(), FakeGitHubOAuth, api(token) helper
  config.test.ts  auth.test.ts  authz.test.ts  entities.test.ts  ws.test.ts  ops.test.ts
```

`package.json` gains `"hub": "node --import tsx hub/src/main.ts"` and the dependencies `ws` and `@types/ws`. `tsconfig.json` `include` gains `"hub/**/*.ts"`. `vitest.config.mts` `include` already matches `tests/**/*.test.ts`.

---

### Task 1: Config, database, health

**Files:**
- Create: `hub/src/config.ts`, `hub/src/db.ts`, `hub/src/http.ts`, `hub/src/server.ts`, `hub/src/main.ts`, `hub/migrations/20261030000000_init/migration.sql`
- Modify: `package.json` (scripts + deps), `tsconfig.json` (`include`)
- Test: `tests/hub/harness.ts`, `tests/hub/config.test.ts`

**Interfaces:**
- Produces `loadConfig(env: NodeJS.ProcessEnv): HubConfig` where `HubConfig = { port: number; dataDir: string; publicUrl: string; githubClientId: string; githubClientSecret: string; trustProxy: boolean; githubApiBase: string; githubOauthBase: string; bindHost: "0.0.0.0" | "127.0.0.1" }`. `githubApiBase` defaults `https://api.github.com`, `githubOauthBase` defaults `https://github.com`; both overridable by `MERGEPORT_HUB_GITHUB_API_BASE` / `MERGEPORT_HUB_GITHUB_OAUTH_BASE` (tests only; documented as such).
- Produces `openHubDb(dataDir: string): Database` (better-sqlite3), applying `hub/migrations`.
- Produces `createHub(opts: { config: HubConfig; db: Database; now?: () => number; log?: Logger }): Hub` with `Hub = { listen(port?: number): Promise<{ port: number; url: string }>; close(): Promise<void> }`.
- Produces `HttpError(status: number, message: string, headers?: Record<string,string>)`, `json(res, status, body)`, `readJson<T>(req, schema: ZodType<T>, limitBytes = 1_000_000): Promise<T>` (throws `HttpError(400)`), `route(method, pattern, handler)` with `:param` segments.
- Test harness produces `startTestHub(o?: { now?: () => number; dataDir?: string }): Promise<TestHub>` where `TestHub = { url: string; db: Database; github: FakeGitHubOAuth; close(): Promise<void>; api(token?: string): (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; headers: Headers }> }`. `FakeGitHubOAuth` is an `http` server with `POST /login/device/code`, `POST /login/oauth/access_token`, `GET /user`, and methods `addUser({ id: bigint, login, name?, avatarUrl? })`, `authorize(userCode, userId)` (marks a device code as approved by that user), `deny(userCode)`.

Schema for the migration (SQLite; `data` and `applied_ops` are JSON text):

```
team(id TEXT PK, name, created_at, owner_github_id INTEGER)
member(github_id INTEGER PK, login, name, avatar_url, role, status, invited_by INTEGER, invited_at, joined_at)
invite(id TEXT PK, github_login TEXT, role, created_by INTEGER, created_at, expires_at, used_at)
space(id TEXT PK, kind, name, created_at, created_by INTEGER, seq INTEGER NOT NULL DEFAULT 0)
space_member(space_id, github_id, can_write INTEGER, PK(space_id, github_id))
entity(space_id, type, entity_id, version INTEGER, deleted INTEGER, data TEXT, applied_ops TEXT, updated_at, updated_by INTEGER, seq INTEGER, PK(space_id, type, entity_id))
entity_event(space_id, seq INTEGER, type, entity_id, version, deleted, data, op_id, actor_github_id, at, PK(space_id, seq))
session(id_hash TEXT PK, github_id INTEGER, created_at, last_seen_at, expires_at, client_name, cursor_json TEXT)
```

- [ ] **Step 1: Write the failing tests** in `tests/hub/config.test.ts`

```ts
it("refuses to start without GitHub OAuth values", () => {
  expect(() => loadConfig({ MERGEPORT_HUB_PUBLIC_URL: "https://h.example" })).toThrow(/MERGEPORT_HUB_GITHUB_CLIENT_ID/);
});
it("binds loopback unless trustProxy=false and https public url", () => {
  const base = { MERGEPORT_HUB_GITHUB_CLIENT_ID: "a", MERGEPORT_HUB_GITHUB_CLIENT_SECRET: "b", MERGEPORT_HUB_DATA: "x" };
  expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "true" }).bindHost).toBe("127.0.0.1");
  expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "http://h.example", MERGEPORT_HUB_TRUST_PROXY: "false" }).bindHost).toBe("127.0.0.1");
  expect(loadConfig({ ...base, MERGEPORT_HUB_PUBLIC_URL: "https://h.example", MERGEPORT_HUB_TRUST_PROXY: "false" }).bindHost).toBe("0.0.0.0");
});
it("serves /health with team null before bootstrap", async () => {
  const hub = await startTestHub();
  const r = await hub.api()("GET", "/health");
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, team: null, schema: 1, publicUrl: hub.url, githubHost: "github.com" });
  await hub.close();
});
it("refuses a database from a newer hub", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hub-"));
  const db = openHubDb(dir); db.prepare("INSERT INTO _mergeport_migrations (name, applied_at) VALUES ('99999999999999_future', 'now')").run(); db.close();
  expect(() => openHubDb(dir)).toThrow(/newer/);
});
it("answers 400 to a malformed JSON body", async () => {
  const hub = await startTestHub();
  const r = await fetch(hub.url + "/auth/device/poll", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
  expect(r.status).toBe(400);
  await hub.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/hub/config.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add dependencies and scripts**

Run: `npm i ws && npm i -D @types/ws`. Add `"hub": "node --import tsx hub/src/main.ts"` to `scripts`; add `"hub/**/*.ts"` to `tsconfig.json` `include`.

- [ ] **Step 4: Implement `hub/src/config.ts`** — `loadConfig` with zod; `bindHost` derived as in the constraint; `MERGEPORT_HUB_PORT` default `8787`; `MERGEPORT_HUB_DATA` required.

- [ ] **Step 5: Implement `hub/src/db.ts`** — `openHubDb(dataDir)`: `applyMigrations(path.join(dataDir, "hub.db"), path.resolve(__dirname, "../migrations"))` from `@/lib/db/migrate` (import by relative path `../../src/lib/db/migrate` so `tsx` resolves it without the `@` alias), then `new Database(file)` with `pragma("journal_mode = WAL")`, `pragma("foreign_keys = ON")`. Write the migration SQL.

- [ ] **Step 6: Implement `hub/src/http.ts` and `hub/src/server.ts`** — router with `GET /health` returning `{ ok: true, team: row ?? null, schema: 1, publicUrl: config.publicUrl, githubHost: "github.com" }` where `team` is `{ name }`. Unmatched → `404 { error: "not found" }`. `HttpError` → its status and `{ error: message }`. Any other throw → `500 { error: "internal" }` and a log line without the body. `POST /auth/device/poll` exists as a stub returning `400` on bad JSON (full behaviour in Task 2).

- [ ] **Step 7: Implement `hub/src/main.ts`** — `loadConfig(process.env)`, `openHubDb`, `createHub(...).listen(config.port)` on `config.bindHost`, log the URL, `SIGTERM`/`SIGINT` → `close()`.

- [ ] **Step 8: Write `tests/hub/harness.ts`** — `FakeGitHubOAuth` and `startTestHub` (temp `dataDir` per hub, port 0, `githubApiBase`/`githubOauthBase` pointing at the fake, `trustProxy: true`, `publicUrl` set to the listened URL after `listen` by passing `publicUrl: ""` and letting `createHub` fall back to the listened URL when empty).

- [ ] **Step 9: Run tests**

Run: `npx vitest run tests/hub/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add hub tests/hub package.json package-lock.json tsconfig.json
git commit -m "feat(hub): config, database, health route"
```

---

### Task 2: Device-flow sign-in, sessions, owner bootstrap, invites

**Files:**
- Create: `hub/src/github-oauth.ts`, `hub/src/auth.ts`, `hub/src/log.ts`
- Modify: `hub/src/server.ts`
- Test: `tests/hub/auth.test.ts`

**Interfaces:**
- `github-oauth.ts`: `startDeviceFlow(cfg): Promise<{ deviceCode; userCode; verificationUri; interval; expiresIn }>` (POST `${oauthBase}/login/device/code` with `client_id`, `scope: "read:user"`); `pollDeviceFlow(cfg, deviceCode): Promise<{ kind: "pending" } | { kind: "slow_down" } | { kind: "expired" } | { kind: "denied" } | { kind: "token"; accessToken: string }>`; `fetchGithubUser(cfg, accessToken): Promise<{ id: bigint; login: string; name: string | null; avatarUrl: string | null }>` (GET `${apiBase}/user`). The GitHub access token is used once for `/user` and discarded; it is never stored.
- `auth.ts`: `createSession(db, githubId, clientName, now): string` (returns the raw token), `findSession(db, rawToken, now): Session | null` (slides `expires_at` to `now + 30d` and sets `last_seen_at`; returns null when expired), `revokeSessions(db, githubId)`, `bootstrapOrAdmit(db, user, now): { ok: true; member } | { ok: false; reason: "not-invited" | "removed" }`: if `team` is empty → create team named `"<login>'s team"`, member row OWNER ACTIVE; else if member ACTIVE → update login/name/avatar; else if member REMOVED → `removed`; else if an unused, unexpired invite matches `lower(login)` → create member with the invite's role, `used_at = now`; else `not-invited`.
- `log.ts`: `Logger = { info(msg, fields?); warn(...); error(...) }` with a `redact(fields)` that drops keys matching `/token|secret|code|data/i`.
- Routes: `POST /auth/device/start` → `200 { deviceCode, userCode, verificationUri, interval, expiresIn }` (rate limit in Task 6); `POST /auth/device/poll { deviceCode }` → `202 { pending: true }`, `200 { session, member, team }`, `403 { reason }`, `410 { error: "expired" }`; `POST /auth/logout` (auth) → `204`; `GET /me` (auth) → `{ member, team, members: [...], spaces: [...] }` (spaces come from Task 3; return `[]` until then).
- `member` JSON shape: `{ githubId: string, login, name, avatarUrl, role, status }`. `team`: `{ id, name }`.
- Auth middleware `requireSession(req): Session` throws `HttpError(401)` when the header is missing, not `Bearer <token>`, or unknown/expired; throws `HttpError(403, "removed")` when the member is REMOVED.

- [ ] **Step 1: Write the failing tests** in `tests/hub/auth.test.ts`

```ts
it("first sign-in bootstraps the owner and names the team", async () => {
  hub.github.addUser({ id: 101n, login: "olive" });
  const start = (await hub.api()("POST", "/auth/device/start")).body;
  expect((await hub.api()("POST", "/auth/device/poll", { deviceCode: start.deviceCode })).status).toBe(202);
  hub.github.authorize(start.userCode, 101n);
  const r = await hub.api()("POST", "/auth/device/poll", { deviceCode: start.deviceCode });
  expect(r.status).toBe(200);
  expect(r.body.member).toMatchObject({ githubId: "101", login: "olive", role: "OWNER", status: "ACTIVE" });
  expect(r.body.team.name).toBe("olive's team");
  expect((await hub.api()("GET", "/health")).body.team).toEqual({ name: "olive's team" });
});
it("a second person is refused until invited, then admitted with the invite's role", async () => { /* owner signs in; alice polls → 403 not-invited; owner POST /admin/invites {githubLogin:"Alice", role:"MEMBER"}; alice signs in → 200 role MEMBER; invite used_at set */ });
it("a removed member gets 403 removed and their session dies", async () => { /* after Task 3's DELETE /admin/members/:id: old token → 403 on /me; new device flow → 403 { reason: "removed" } */ });
it("sessions slide 30 days and expire unused", async () => { /* now() controllable: request at day 29 keeps it alive; silence 31 days → 401 */ });
it("malformed Authorization is 401, not 500", async () => {
  for (const h of ["Bearer", "Bearer ", "Basic abc", "Token x"]) {
    const r = await fetch(hub.url + "/me", { headers: { authorization: h } });
    expect(r.status).toBe(401);
  }
});
it("denied and expired device codes", async () => { /* deny → 403 { reason: "denied" }; fake marks expired → 410 */ });
it("the GitHub access token is never stored or logged", async () => { /* grep every table's text columns and the captured log lines for the fake's token string */ });
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/hub/auth.test.ts` — Expected: FAIL (routes 404).

- [ ] **Step 3: Implement `github-oauth.ts`, `auth.ts`, `log.ts`, and the routes** per the Interfaces block. Session token: `randomBytes(32).toString("base64url")`; stored as `createHash("sha256")`. Device-poll `slow_down` → treat as pending. Hub `log` captures lines into an array when `createHub` gets a `log` with a sink (harness passes one).

- [ ] **Step 4: Run tests** — Expected: PASS for all but the removal test (needs Task 3; mark it `it.todo` until then, un-todo in Task 3).

- [ ] **Step 5: Commit**

```bash
git add hub tests/hub
git commit -m "feat(hub): GitHub device-flow sign-in, sessions, owner bootstrap, invites"
```

---

### Task 3: Roles, members, spaces, space membership

**Files:**
- Create: `hub/src/authz.ts`
- Modify: `hub/src/server.ts`, `hub/src/auth.ts` (invite creation moves here or stays; one place)
- Test: `tests/hub/authz.test.ts`

**Interfaces:**
- `authz.ts`: `requireRole(member, min: Role)` (order READER < MEMBER < ADMIN < OWNER; throws `HttpError(403)`); `spaceAccess(db, member, spaceId): { canRead: boolean; canWrite: boolean }` — COMMON: read if ACTIVE, write if role ≥ MEMBER; RESTRICTED: from `space_member`, and `canWrite` additionally requires role ≥ MEMBER; `listSpacesFor(db, member): { id, kind, name, canWrite, seq }[]`.
- On bootstrap (Task 2) the COMMON space is created: `space(id = "common", kind = COMMON, name = "Workspace")`.
- Admin routes (ADMIN+ unless noted):
  - `GET /admin/members` → `{ members }`; `POST /admin/invites { githubLogin, role }` → `201 { invite }` (role ≤ ADMIN; only OWNER may invite ADMIN); `DELETE /admin/members/:githubId` → `204` (cannot remove OWNER → `409`; ADMIN cannot remove ADMIN → `403`; sets status REMOVED, deletes `space_member` rows, `revokeSessions`, notifies in Task 5); `PATCH /admin/members/:githubId { role }` → `200` (only OWNER may set or unset ADMIN; `role: "OWNER"` transfers ownership, OWNER only, old owner becomes ADMIN).
  - `GET /admin/spaces` → `{ spaces: [{ id, kind, name, members: [{ githubId, canWrite }] }] }`; `POST /admin/spaces { name, members }` → `201`; `PATCH /admin/spaces/:id { name?, members? }` → `200` (COMMON: name only); `DELETE /admin/spaces/:id` → `204` (COMMON → `409`; deletes entities, events, members).
- `GET /me` now returns `spaces: listSpacesFor(...)` and `members` for every ACTIVE member.

- [ ] **Step 1: Write the failing tests** in `tests/hub/authz.test.ts` — a helper `signIn(hub, id, login)` returning a token (reuse from auth tests via harness). Tests: `READER cannot POST /admin/invites (403)`; `ADMIN cannot invite ADMIN, OWNER can`; `OWNER cannot be removed (409)`; `every active member sees the member list in /me`; `restricted space invisible in /me to non-member, visible with canWrite per space_member and role`; `READER in a restricted space with can_write=1 still cannot write (role floor)`; `DELETE /admin/spaces/common is 409`; `ownership transfer swaps roles`.

- [ ] **Step 2: Run to verify fail** — `npx vitest run tests/hub/authz.test.ts`.

- [ ] **Step 3: Implement** `authz.ts` and routes. Un-todo the removal test in `auth.test.ts`.

- [ ] **Step 4: Run** `npx vitest run tests/hub` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(hub): roles, member administration, spaces and space membership"`.

---

### Task 4: Entities: ops, events by cursor, snapshot, pruning

**Files:**
- Create: `hub/src/entities.ts`
- Modify: `hub/src/server.ts`
- Test: `tests/hub/entities.test.ts`, `tests/hub/ops.test.ts`

**Interfaces:**
- `Op = { opId: string; type: string; entityId: string; kind: "UPSERT" | "DELETE"; baseVersion: number; data?: Record<string, unknown> }`; `OpResult = { opId; status: "applied" | "duplicate" | "stale"; version: number; current?: EntityJson }`; `EntityJson = { schema: 1; type; id; version; deleted; appliedOps: string[]; updatedAt: string; updatedBy: { id: string; login: string }; data }` (same shape as the client's `EntityFile`).
- `applyOps(db, space, actor: { githubId: bigint; login: string }, ops: Op[], now): { results: OpResult[]; seq: bigint }` — one `db.transaction`; per op in order: duplicate if `opId` in `applied_ops` or in `entity_event.op_id` for that entity; stale if `baseVersion !== current.version` (0 when absent); else write `entity` (version+1, `applied_ops` trimmed to last 50, `deleted = kind === DELETE`, `data = {}` on delete), increment `space.seq`, insert `entity_event`. Returns after commit; the caller then notifies.
- `eventsSince(db, spaceId, since: bigint, limit = 500): { seq; events: EventJson[]; more: boolean } | "gone"` — `"gone"` when `since < minRetainedSeq(spaceId)` and `since < space.seq`; `EventJson = EntityJson & { seq: string; opId: string }`.
- `snapshot(db, spaceId): { seq; entities: EntityJson[] }` — includes tombstones.
- `prune(db, now)` — deletes events with `at < now - 30d` **and** `seq <= min(cursor over active sessions for that space)`; cursors come from `session.cursor_json` (`{ [spaceId]: seq }`), updated on every successful `GET /spaces/:id/entities` by that session. Runs every 10 min from `server.ts` and at start.
- Routes: `GET /spaces/:id/entities?since=<seq>` → `{ seq, events, more }` or `410 { error: "gone" }`; `GET /spaces/:id/snapshot`; `POST /spaces/:id/ops { ops }` → `{ results, seq }`; all require `canRead` (write requires `canWrite` → else `403`). Unknown space → `404`.
- Body validation with zod: `ops` max 500 items; `data` max 256 KiB serialized per op; `type` matches `/^[a-z][a-z0-9-]{0,31}$/`; `entityId` max 128 chars.

- [ ] **Step 1: Write the failing tests** in `tests/hub/ops.test.ts`

```ts
it("applies, reports duplicate on retry, and stale on wrong baseVersion", async () => {
  const r1 = await api("POST", "/spaces/common/ops", { ops: [{ opId: "op1", type: "task", entityId: "t1", kind: "UPSERT", baseVersion: 0, data: { title: "a" } }] });
  expect(r1.body.results[0]).toMatchObject({ opId: "op1", status: "applied", version: 1 });
  const r2 = await api("POST", "/spaces/common/ops", { ops: [{ opId: "op1", type: "task", entityId: "t1", kind: "UPSERT", baseVersion: 0, data: { title: "a" } }] });
  expect(r2.body.results[0].status).toBe("duplicate");
  const r3 = await api("POST", "/spaces/common/ops", { ops: [{ opId: "op2", type: "task", entityId: "t1", kind: "UPSERT", baseVersion: 0, data: { title: "b" } }] });
  expect(r3.body.results[0]).toMatchObject({ status: "stale", version: 1, current: { id: "t1", version: 1, data: { title: "a" } } });
});
it("two ops on one entity in one request apply in order", ...);           // second has baseVersion 1 → applied, version 2
it("a delete is a tombstone with a version", ...);                        // deleted true, version 2, data {}
it("appliedOps keeps the last 50", ...);
it("a READER gets 403 on ops, 200 on entities", ...);
it("rejects bad bodies with 400: ops not array, baseVersion string, 501 ops, oversized data", ...);
it("seq survives a restart", async () => { /* apply 3 ops; hub.close(); startTestHub({ dataDir: same }); apply 1 → seq 4 */ });
```

and `tests/hub/entities.test.ts`:

```ts
it("entities?since returns only newer events and advances seq", ...);
it("snapshot includes tombstones", ...);
it("since older than retained log is 410 after prune; snapshot recovers", async () => { /* now() jumps 31 days; a session whose cursor is current; prune(); old since → 410 */ });
it("prune keeps events an active session has not read yet", ...);
it("entities of a restricted space are 404 to a non-member (not 403)", ...);  // existence is not revealed
```

- [ ] **Step 2: Run to verify fail**.

- [ ] **Step 3: Implement `entities.ts` and routes** per Interfaces. `updatedBy.id` is the actor's githubId as a string.

- [ ] **Step 4: Run** `npx vitest run tests/hub` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(hub): entity ops with per-entity optimistic concurrency, event log, snapshot, pruning"`.

---

### Task 5: WebSocket notifications

**Files:**
- Create: `hub/src/notify.ts`
- Modify: `hub/src/server.ts` (upgrade handling), `hub/src/entities.ts` (call `notify.changed` after commit), admin routes (access/team fanout, `bye`)
- Test: `tests/hub/ws.test.ts`

**Interfaces:**
- `createNotifier(deps: { db; now; findSession }): Notifier` with `attach(server: http.Server)`, `changed(spaceId, seq)` (coalesced 100 ms per space, sent to sockets whose member `canRead` the space), `access(githubId | "space:" + spaceId, spaceId, action: "added" | "removed" | "deleted")`, `team(reason: "member" | "role")` (all sockets), `kick(githubId, reason: "removed")` (send `bye`, close `4403`), `shutdown()` (send `bye shutdown`, close `1001`).
- Handshake: `GET /ws`, header `Sec-WebSocket-Protocol: mergeport.v1, bearer.<token>`; server selects `mergeport.v1`. Missing/invalid token → respond `401` before upgrade. First message `{ t: "hello", spaces: [{ id, seq }] }` from `listSpacesFor`.
- Client `{ t: "ping" }` → server `{ t: "pong" }`; a socket with no message for 75 s is terminated.
- Messages exactly as the spec lists them; `seq` as a string.

- [ ] **Step 1: Write the failing tests** in `tests/hub/ws.test.ts` using Node's global `WebSocket` (`new WebSocket(url, ["mergeport.v1", "bearer." + token])`)

```ts
it("sends hello with spaces and seq", ...);
it("one changed per space for a burst of ops within 100 ms", ...);     // apply 5 ops quickly → exactly one { t: "changed", spaceId: "common", seq: "5" }
it("a non-member of a restricted space gets no changed for it", ...);
it("removing a member closes with 4403 and an in-flight push is 403", ...);  // Review Focus 3
it("invalid token is refused before upgrade", ...);                   // fetch /ws with bad protocol → 401
it("silent socket is dropped after 75 s, pinging one stays", ...);     // fake timers
it("access added/removed/deleted and team member/role fan out", ...);
```

- [ ] **Step 2: Run to verify fail**.

- [ ] **Step 3: Implement `notify.ts`**, wire `changed` in `applyOps` callers, `access`/`team`/`kick` in the admin routes, `shutdown` in `Hub.close()`.

- [ ] **Step 4: Run** `npx vitest run tests/hub` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(hub): WebSocket change notifications, access and team events"`.

---

### Task 6: Rate limits, log redaction, operator docs

**Files:**
- Create: `hub/src/ratelimit.ts`, `hub/README.md`
- Modify: `hub/src/server.ts`, `README.md` (one paragraph under "Personal and Team" pointing at `hub/README.md`; the full client story lands in plan 3)
- Test: `tests/hub/ratelimit.test.ts`, extend `tests/hub/auth.test.ts` (log redaction)

**Interfaces:**
- `createLimiter(now): { take(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfterSec: number } }` sliding window in memory.
- Keys: `session:<id_hash>` → 60 per 10 000 ms on every authenticated route; `device:<ip>` → 10 per 60 000 ms on `/auth/device/start`; ip from `X-Forwarded-For` first entry when `trustProxy`, else socket address. Over limit → `429 { error: "rate limited" }` with `Retry-After`.
- Log line per request: `method path status ms` plus `member=<githubId>` when known; never the body, query, token or user code.

- [ ] **Step 1: Write the failing tests** — `61st request within 10 s is 429 with Retry-After`; `11th device start per IP per minute is 429`; `X-Forwarded-For honoured only with trustProxy`; in `auth.test.ts`: captured log lines contain neither the session token, the fake's access token, nor the user code.

- [ ] **Step 2: Run to verify fail**.

- [ ] **Step 3: Implement** limiter and wiring; request log line in `server.ts`.

- [ ] **Step 4: Write `hub/README.md`** covering, in this order: requirements (Node 24, a domain, a reverse proxy); registering the GitHub OAuth App (Homepage URL = public URL, enable Device Flow, no callback URL, copy client id and secret); the `.env` with every `MERGEPORT_HUB_*` variable from the spec; `npm ci && npm run hub`; a two-line Caddyfile (`hub.example.com { reverse_proxy 127.0.0.1:8787 }`); a systemd unit; backup `sqlite3 hub.db ".backup hub-$(date +%F).db"`; upgrade (stop, `git pull`, `npm ci`, start: migrations apply at start, a newer database is refused); what the hub stores and never stores (no GitHub tokens, no source code, no issues).

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; the existing suites unchanged.

- [ ] **Step 6: Commit** — `git commit -m "feat(hub): rate limits, redacted request log, operator README"`.

---

## Self-review notes

- Spec coverage: config and binding (T1), schema (T1), device flow/sessions/bootstrap/invites/expiry (T2), roles and admin routes, `/me` members and spaces (T3), op semantics, cursor, 410, snapshot, appliedOps 50, pruning (T4), WebSocket messages, coalescing, ping/75 s, 4403, shutdown (T5), rate limits, log redaction, README with Caddy/systemd/backup/upgrade (T6). `githubHost` in `/health` (T1). Not in this plan, by design: everything client-side (plans 2 and 3).
- Review Focus 1, 2, 4 → T4 tests; 3 → T5; 5 → T2.
- Names used across tasks: `requireSession`, `requireRole`, `spaceAccess`, `listSpacesFor`, `applyOps`, `eventsSince`, `snapshot`, `prune`, `createNotifier`, `createLimiter`, `startTestHub`, `FakeGitHubOAuth.authorize/deny/addUser` — consistent as written.

## API notes for client sessions

Deviations and additions made while building the hub (the code and `hub/README.md` are authoritative):

- `GET /spaces/:id/entities` returns `{ seq, events, more }`; pages of 500, optional `limit` query. Loop until `more` is false, feeding the returned `seq` back as `since`.
- Ops request body is capped at 16 MiB (413 beyond); batch by byte size.
- `POST /admin/invites` answers `{ invite: { id, githubLogin, role, createdAt, expiresAt } }`; invites expire after 7 days. Inviting a removed login is 409 "member was removed".
- `PATCH /admin/members/:id` answers `{ member }`; space routes answer `{ space }`.
- `access: added` is also sent when a member's `canWrite` on a space changes.
- A `team` event with reason `member` is also sent when an invite is accepted.
- The socket closes with 4401 on logout or an expired session, and 4403 on removal. A removed member's token answers 401 after removal.
- `/me` `spaces[].seq` is a string, like `seq` in `hello`, `changed`, entities and snapshot.
- `requireSession` is the single authentication entry point; it also applies the 60 per 10 s per-session rate limit.
