# Hub Client Implementation Plan (plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SyncEngine` can synchronize a space against a hub (cursor pull, per-op push, three-way merge on `stale`, snapshot resync) next to the unchanged GitHub path, with a live WebSocket link, an encrypted hub session store and the schema changes plan 3 builds on.

**Architecture:** A narrow `HubClient` interface (HTTP, per spec) plus `Backend = github | hub`. `SyncEngine.pullSpace`/`pushSpace` dispatch on `space.backend`; the current bodies move verbatim into `pullGithub`/`pushGithub`; new `pullHub`/`pushHub` reuse `reconcile`, `openConflict`, `blockEntity`, `revokeSpace`, `stateFor`. `HubLink` (WebSocket, injected socket factory) turns `changed` into debounced `syncSpace` calls. Tests run against an in-process `FakeHub` (tests/hub-client/fake-hub.ts) served over real loopback HTTP; the WebSocket side is a fake in-memory socket, so this plan adds no dependency (the hub's `ws` comes with plan 1).

**Tech Stack:** Node 24, TypeScript, Prisma 7 + SQLite, vitest, global `fetch`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-10-29-hub-server-design.md` (sections "The client", "Transport abstraction", "Live updates", "Hub session token storage", "Space deletion and loss of access", op semantics under "HTTP API"). JSON shapes (`Op`, `OpResult`, `EntityJson`, `EventJson`) are fixed by `docs/superpowers/plans/2026-10-29-hub-service.md` Task 4. Plan 3 (profiles, switching, sign-in/Team UI) and the runtime wiring in `src/lib/local/runtime.ts` are NOT in this plan.

## Global Constraints

- GitHub mode behaviour unchanged: `tests/team-sync.test.ts`, `tests/review-fixes.test.ts` and every existing test pass **without edits**. Existing `SyncEngine` construction (`{ db, actor, store, ... }`) keeps working; `hub` deps are optional.
- Names fixed for plan 3, exactly: `Backend`, `HubClient`, `HubLink`, `Space.backend` (`GITHUB|HUB`), `Space.hubSpaceId`, `Space.hubCursor`, `TeamConfig.backend`, `TeamConfig.hubOrigin`, `HubSession`.
- Hub spaces: `repoOwner`/`repoName` are empty strings; unique index `(backend, repoOwner, repoName, hubSpaceId)`.
- Hub URLs: `https://` only, except loopback (`127.0.0.1`, `localhost`, `[::1]`) which may be `http://`.
- Pull: `hubCursor` advances to the response `seq`; `410` → snapshot resync; entities absent from the snapshot are deleted locally.
- Push: one request per round; results `applied|duplicate|stale`; at most 3 rounds per cycle.
- `HubLink`: reconnect backoff 1 s → 30 s with jitter; 100 ms debounce per space; client ping every 25 s; fallback poll every 60 s while the socket is down; close code `4403` = removed (no reconnect).
- `expectedConsistencyDelaySeconds` for hub live reports "about 1 s (live)"; GitHub numbers unchanged.
- Session token is encrypted (AES-256-GCM) with a per-profile key file `<profile dir>/key` (mode `0600`, restricted ACL on Windows); never in logs, URLs, `hubs.json` or a space.
- Hub-removed or hub-deleted spaces are **purged** by `revokeSpace` on every client, admin included (hub spaces never carry `canAdmin`).
- `npm run typecheck`, `npm run lint`, `npm test` pass at the end of every task.

## Review Focus

1. Hub event for an entity with `schema` newer than `ENTITY_SCHEMA` or an unknown type: skipped/blocked, never rewritten, cursor still advances. Pinned in Task 5.
2. `apply` throws for one entity during a hub pull: cursor must NOT advance past it (retried next pull), other entities still applied. Pinned in Task 5.
3. Hub `seq` lower than local `hubCursor` (hub restored from an older backup): treat as `gone` and resync from snapshot, never silently stall. Pinned in Task 5.
4. Push response lost after the hub applied it (network error), then retry: result `duplicate`, op removed, no double apply, entity base correct. Pinned in Task 6.
5. Remote edit vs local delete (and the reverse) during `stale`: one `SyncConflict` with `__deleted`, op paused, nothing lost. Pinned in Task 6.
6. Socket flapping and `changed` bursts: one sync cycle per space at a time, debounced; `4403` stops reconnecting. Pinned in Task 7.

---

## File structure

```
prisma/schema.prisma                       + Space.backend/hubSpaceId/hubCursor, TeamConfig.backend/hubOrigin, HubSession
prisma/migrations/20261030130000_hub_client/migration.sql
src/lib/hub/types.ts                       Op, OpResult, EntityJson, EventJson, Me, HubClient, Backend, HubError
src/lib/hub/client.ts                      HttpHubClient, normalizeHubOrigin, checkHubHealth
src/lib/hub/session-vault.ts               key file, encrypt/decrypt, save/load/clear HubSession
src/lib/hub/spaces.ts                      syncHubSpaces(db, engine, me): Space rows from /me
src/lib/hub/link.ts                        HubLink
src/lib/hub/live.ts                        startHubLive(...): wires link + engine + spaces
src/lib/sync/engine.ts                     dispatch, pullGithub/pushGithub (moved), pullHub/pushHub, delay fn
tests/hub-client/fake-hub.ts               FakeHub (in-process hub semantics + http handler + fake sockets)
tests/hub-client/harness.ts                makeHubClient(): isolated SQLite + engine against a FakeHub
tests/hub-sync.test.ts                     client-side scenarios
tests/hub-client/*.test.ts                 per-module unit tests
```

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261030130000_hub_client/migration.sql`
- Test: `tests/hub-client/schema.test.ts`

**Interfaces:**
- Produces (Prisma): `enum SpaceBackend { GITHUB HUB }`, `enum TeamBackend { GITHUB HUB }`; `Space.backend SpaceBackend @default(GITHUB)`, `Space.hubSpaceId String @default("")`, `Space.hubCursor BigInt @default(0)`; `TeamConfig.backend TeamBackend @default(GITHUB)`, `TeamConfig.hubOrigin String?`; `model HubSession { id String @id @default("session"); origin String; cipher String; githubId BigInt; login String; createdAt DateTime @default(now()); updatedAt DateTime @updatedAt }`. `@@unique([repoOwner, repoName])` on `Space` is replaced by `@@unique([backend, repoOwner, repoName, hubSpaceId])`.

- [ ] **Step 1: Write the failing test** `tests/hub-client/schema.test.ts` using `createPrisma` like `tests/harness.ts`: existing-style GitHub space still created with defaults (`backend === "GITHUB"`, `hubCursor === 0n`, `hubSpaceId === ""`); two HUB spaces with `repoOwner:"" repoName:""` and different `hubSpaceId` coexist; a duplicate `(HUB, "", "", "common")` throws; a duplicate GitHub `(owner, name)` still throws; `teamConfig` defaults `backend === "GITHUB"`, `hubOrigin === null`; `hubSession` round-trips a `cipher` string.
- [ ] **Step 2: Run** `npx vitest run tests/hub-client/schema.test.ts` — Expected: FAIL (fields unknown).
- [ ] **Step 3: Edit `schema.prisma`** per Interfaces; write the migration SQL by hand: `DROP INDEX "Space_repoOwner_repoName_key"`, three `ALTER TABLE "Space" ADD COLUMN` (with defaults `'GITHUB'`, `''`, `0`), two `ALTER TABLE "TeamConfig" ADD COLUMN`, `CREATE TABLE "HubSession"`, `CREATE UNIQUE INDEX "Space_backend_repoOwner_repoName_hubSpaceId_key"`. Run `npx prisma generate`. Check the SQL matches what `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script` would emit semantically (no table rebuild needed).
- [ ] **Step 4: Run** `npx vitest run tests/hub-client/schema.test.ts tests/migration.test.ts tests/team-sync.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub-client): schema for hub backend (Space, TeamConfig, HubSession)`.

---

### Task 2: Hub types, HTTP client, fake hub

**Files:**
- Create: `src/lib/hub/types.ts`, `src/lib/hub/client.ts`, `tests/hub-client/fake-hub.ts`
- Test: `tests/hub-client/client.test.ts`

**Interfaces:**
- `types.ts` produces: `Op`, `OpResult`, `EntityJson`, `EventJson` exactly as plan 1 Task 4 (`EntityJson = EntityFile` shape from `engine.ts`; `EventJson = EntityJson & { seq: string; opId: string }`); `Me = { member: { githubId: string; login: string; name: string|null; avatarUrl: string|null; role: string; status: string }; team: { id: string; name: string }; members: unknown[]; spaces: { id: string; kind: "COMMON"|"RESTRICTED"; name: string; canWrite: boolean; seq: string }[] }`; `HubClient` exactly as the spec (`me`, `pull(spaceId, since: bigint)`, `snapshot`, `push`), where `pull` resolves `{ seq: bigint; events: EntityEvent[]; more?: boolean } | "gone"` (`EntityEvent` = `EventJson` with `seq: bigint`); `Backend` as in the spec; `HubError extends Error { kind: "network"|"auth"|"forbidden"|"not-found"|"rate-limited"|"schema"|"unknown"; status?: number; retryAfterSeconds?: number }`.
- `client.ts` produces: `normalizeHubOrigin(input: string): string` (trim, lowercase host, drop path/trailing slash; throws `HubError("unknown")` for non-https unless loopback); `class HttpHubClient implements HubClient { constructor(origin: string, getToken: () => Promise<string | null>, fetchImpl?: typeof fetch) }` mapping 401→`auth`, 403→`forbidden`, 404→`not-found`, 429→`rate-limited` (+`Retry-After`), 410 on pull→`"gone"`, fetch rejection→`network`; JSON `seq` strings ↔ `bigint`; `checkHubHealth(origin, supportedSchema = 1, fetchImpl?): Promise<{ teamName: string | null; publicUrl: string; githubHost: string }>` that throws `HubError("schema")` when `health.schema > supportedSchema` and `HubError("unknown")` when `publicUrl` (normalized) differs from the origin typed or `githubHost !== "github.com"`.
- `fake-hub.ts` produces `class FakeHub` implementing the hub semantics of plan 1 (one team, spaces map, `Entity`/`EntityEvent` per space, per-op `applied|duplicate|stale`, `appliedOps` last 50, `since` older than `minSeq` → 410, snapshot incl. tombstones) with: `addMember(githubId, login, role)`, `token(githubId): string`, `createSpace(id, kind, name, members?)`, `listen(): Promise<{ url: string }>` (real `node:http`, loopback, port 0; routes `/health`, `/me`, `/spaces/:id/entities`, `/spaces/:id/snapshot`, `/spaces/:id/ops`; 401/403/404 as the spec), `close()`, `restart()` (drops sockets, keeps state), `removeMember(githubId)` (403 afterwards; sockets get `bye`/close 4403), `deleteSpace(id)`, `pruneBefore(seq)`, `failNext(n, "network")` / `dropNextResponse()` (apply the op then drop the HTTP response, for lost-response tests), `setSchema(n)`, `socket(token): FakeSocket` (in-memory WebSocket-like: `onopen/onmessage/onclose`, `send`, `close(code)`, delivers `hello`, `changed` (coalesced 100 ms), `access`, `team`, `bye`), `entity(spaceId, type, id)`, `seq(spaceId)`.

- [ ] **Step 1: Write the failing tests** `tests/hub-client/client.test.ts`: `normalizeHubOrigin("https://Hub.Example.com/x/")` → `"https://hub.example.com"`; `http://hub.example.com` throws; `http://127.0.0.1:8787`, `http://localhost:1`, `http://[::1]:1` accepted; against a started FakeHub: `me()` lists spaces with `seq` as strings parsed; `push` of a new entity → `applied` version 1, same `opId` again → `duplicate`, wrong `baseVersion` → `stale` with `current.version === 1`; `pull(space, 0n)` returns that event with `seq` bigint; after `pruneBefore` a stale cursor → `"gone"`; token missing/invalid → `HubError.kind === "auth"`; removed member → `"forbidden"`; unknown space → `"not-found"`; stopped hub → `"network"`; `checkHubHealth` refuses `setSchema(2)` (`kind "schema"`), a `publicUrl` mismatch, and a non-`github.com` host.
- [ ] **Step 2: Run** `npx vitest run tests/hub-client/client.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `types.ts`, `client.ts` and `fake-hub.ts` per Interfaces. `fake-hub.ts` is test-only code: keep it under ~250 lines, state in plain Maps.
- [ ] **Step 4: Run** the same test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub-client): HubClient types, HTTP client, in-process fake hub`.

---

### Task 3: Encrypted hub session store

**Files:**
- Create: `src/lib/hub/session-vault.ts`
- Test: `tests/hub-client/session-vault.test.ts`

**Interfaces:**
- Produces: `openVault(keyFile: string): Vault` where `Vault = { encrypt(plain: string): string; decrypt(cipher: string): string }` (AES-256-GCM, output `v1.<iv b64>.<tag b64>.<data b64>`; creates `keyFile` with 32 random bytes, mode `0o600`, on `win32` best-effort `icacls <file> /inheritance:r /grant:r <USERNAME>:F` via `execFileSync`, failure swallowed); `saveHubSession(db: Db, vault: Vault, s: { origin: string; token: string; githubId: bigint; login: string }): Promise<void>` (upsert id `"session"`); `loadHubSession(db: Db, vault: Vault): Promise<{ origin: string; token: string; githubId: bigint; login: string } | null>` (null when absent or undecryptable); `clearHubSession(db): Promise<void>`.

- [ ] **Step 1: Write the failing tests**: key file created once and reused (second `openVault` decrypts first's output); `loadHubSession` returns what was saved; the raw `HubSession.cipher` column does not contain the token substring; a different key file → `loadHubSession` returns `null` (no throw); tampered cipher → `null`; `clearHubSession` → `null`; on non-Windows the key file mode is `0o600`; token never appears in the key file.
- [ ] **Step 2: Run** `npx vitest run tests/hub-client/session-vault.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `session-vault.ts` per Interfaces.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub-client): encrypted hub session store with per-profile key file`.

---

### Task 4: Engine dispatch; GitHub path moved unchanged

**Files:**
- Modify: `src/lib/sync/engine.ts`
- Test: existing suites only, plus `tests/hub-client/dispatch.test.ts`

**Interfaces:**
- `EngineDeps` gains `hub?: (space: Space) => HubClient` and `hubLive?: () => boolean`.
- `SyncEngine.pullSpace(space0)` and `pushSpace(space0)` keep their signatures and results; each now begins `if (space.backend === "HUB") return this.pullHub(space0)` / `this.pushHub(...)`; the existing bodies move **verbatim** to `private pullGithub(space0)` / `private pushGithub(space0)`. `pullHub`/`pushHub` exist as stubs returning `{ changed: false, applied: 0 }` / `{ sent: 0 }` (filled in Tasks 5 and 6). `private backendOf(space): Backend` returns `{ kind: "hub", client: this.d.hub(space) }` for HUB (throws `Error("No hub client configured")` when `d.hub` is absent) else `{ kind: "github", store: this.d.store(space) }`.
- `tick()` skips HUB spaces while `this.d.hubLive?.()` is true.

- [ ] **Step 1: Write the failing test** `dispatch.test.ts`: a space with `backend: "HUB"` and an engine with a spy `hub` factory → `pullSpace` calls the factory, never `store`; a GITHUB space never calls `hub`; `pushSpace` on a HUB space without `hub` dep rejects with `/No hub client configured/`.
- [ ] **Step 2: Run** it — Expected: FAIL.
- [ ] **Step 3: Refactor**: rename bodies (cut/paste, no edits inside), add dispatch, stubs, `backendOf`, `tick` filter. Do not touch `reconcile`, `openConflict`, or other methods.
- [ ] **Step 4: Run** `npx vitest run tests/hub-client/dispatch.test.ts tests/team-sync.test.ts tests/review-fixes.test.ts tests/revoke-space.test.ts` then `npm run typecheck` — Expected: PASS. `git diff` of the moved bodies shows only the two renamed signatures.
- [ ] **Step 5: Commit** `refactor(sync): dispatch pull/push on space backend, GitHub path moved unchanged`.

---

### Task 5: Hub pull, snapshot resync, hub spaces, error mapping

**Files:**
- Modify: `src/lib/sync/engine.ts`
- Create: `src/lib/hub/spaces.ts`, `tests/hub-client/harness.ts`
- Test: `tests/hub-sync.test.ts` (new), `tests/hub-client/spaces.test.ts`

**Interfaces:**
- `harness.ts` produces `makeHubClient(hub: FakeHub, githubId: bigint, login: string, opts?: { events?: ... }): Promise<HubTestClient>` where `HubTestClient = { db, engine, actor, client: HttpHubClient, token, sync(): Promise<void> /* me() → syncHubSpaces → syncSpace per space */, space(hubSpaceId): Promise<Space>, close() }`; the engine is built with `hub: () => client`, `store` that throws, fixed clock, and `TeamConfig { mode: TEAM, backend: HUB, hubOrigin }`. It uses `ensureLocalProfile` like `tests/harness.ts`.
- `spaces.ts` produces `syncHubSpaces(db: Db, engine: SyncEngine, me: Me): Promise<{ added: string[]; removed: string[] }>`: upserts a `Space` per `me.spaces` (`backend: "HUB"`, `remoteId = hubSpaceId = id`, `teamRemoteId = me.team.id`, `repoOwner = repoName = ""`, `canWrite` from `me`, `canAdmin: false`, `access: "OK"`); sets `TeamConfig.commonSpaceId` to the COMMON space; a HUB space present locally but absent from `me.spaces` → `engine.revokeSpace(id, "You no longer have access to this space")`.
- `SyncEngine.pullHub(space0): Promise<{ changed: boolean; applied: number }>`: `client.pull(space.hubSpaceId, space.hubCursor)`; `"gone"` or a response `seq` lower than `hubCursor` → `client.snapshot`, reconcile every entity, `vanished` (local non-deleted `SyncEntity` absent from the snapshot and without PENDING/SENT ops) applied as deletion, cursor = snapshot `seq`. Normal events: only the latest event per `(type, id)` is reconciled, in `ENTITY_TYPES` order, through the same guards as `pullGithub` (unknown type ignored, `schema > ENTITY_SCHEMA` → `blockEntity`, cross-space guard, `def.post`). `sha` argument = `String(event.seq)`. Cursor advances to response `seq` (or last event seq when `more`; loop until `more` is false) **only if no entity threw**; a thrown entity is recorded in `lastError` ("Skipped n unreadable entity…") and the cursor stays before it. Then `refreshRole`-free: no GitHub role logic for hub. Always `schedule(space, ...)` with a 60 s base for HUB (`schedule` uses `d.hubLive?.() ? MAX_POLL_MS : 60_000` when `space.backend === "HUB"`).
- `private handleHubError(space, e: unknown, phase: "read"|"write")`: `HubError` `network` → `lastError = "offline"` + schedule error; `auth` → `lastError = "Sign in to the server again"` (ops stay queued); `forbidden` on read or `not-found` → `revokeSpace(space.id, "Access to this space was removed")`; `forbidden` on write → `canWrite=false`, quarantine PENDING/SENT ops (same text as GitHub path); `rate-limited` → `rateLimitedUntil`; other → `lastError = message`.

- [ ] **Step 1: Write failing tests** in `tests/hub-sync.test.ts` (clients `olive` OWNER, `alice` MEMBER on one FakeHub; helper creates a project/card with `seedProject`-style rows via `tests/harness.ts` exports adapted to the hub client): `alice receives olive's project after one sync` (local rows present, `Space.hubCursor === hub.seq("common")`); `a second sync with no news changes nothing (applied 0)`; `entity delete arrives as tombstone and removes the local row`; `cursor expiry: pruneBefore then alice.sync → engine resyncs from snapshot, entities absent from snapshot are deleted locally, cursor equals hub seq`; `hub seq lower than local cursor (hub.resetSeq) → snapshot resync, no stall` (Review Focus 3); `event with schema = ENTITY_SCHEMA + 1 is skipped, SyncEntity.meta.newer true, other events applied, cursor advances` and `unknown type ignored` (Focus 1); `apply throws for one entity → that entity retried on next pull, cursor not advanced, others applied` (force with an event whose data violates a foreign key; assert second sync after the fault is cleared applies it) (Focus 2); `restricted space absent from /me for a non-member: alice has no Space row and the FakeHub answers her 404 for it` (privacy by request); `access removed (hub.removeMember) → next sync revokes: rows purged, ops QUARANTINED, space REVOKED`; `network failure → space.lastError "offline", stateFor "offline", edits stay pending`; `401 → lastError "Sign in to the server again", ops kept`; and in `spaces.test.ts`: `syncHubSpaces creates, updates canWrite, and revokes vanished spaces; commonSpaceId set`.
- [ ] **Step 2: Run** `npx vitest run tests/hub-sync.test.ts tests/hub-client/spaces.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `harness.ts`, `spaces.ts`, `pullHub`, `handleHubError`, `schedule` tweak. Factor the per-entity apply loop shared by event and snapshot reconciliation into one private method inside `engine.ts`; do not change `pullGithub`.
- [ ] **Step 4: Run** the new tests plus `npx vitest run tests/team-sync.test.ts tests/review-fixes.test.ts tests/revoke-space.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub-client): hub pull by cursor, snapshot resync, hub spaces, error handling`.

---

### Task 6: Hub push, `stale` three-way merge, retries

**Files:**
- Modify: `src/lib/sync/engine.ts`
- Test: `tests/hub-sync.test.ts`

**Interfaces:**
- `SyncEngine.pushHub(space0): Promise<{ sent: number }>`: returns `{ sent: 0 }` when `!canWrite || access !== "OK"`. Up to **3 rounds**: PENDING ops (skip `isBlocked` entities) → mark `SENT` (`attempts` +1) → `client.push(hubSpaceId, ops.map(o => ({ opId: o.id, type: o.entityType, entityId: o.entityId, kind: o.kind, baseVersion: o.baseVersion, data: o.kind === "DELETE" ? undefined : o.data })))`; per result: `applied` → upsert `SyncEntity` (`baseVersion = result.version`, `baseData = op.data ?? {}`, `meta.applied` = previous list (last 49) + opId, `deleted = kind === "DELETE"`, `remoteSha = null`), delete op, `sent++`; `duplicate` → delete op, and update the base exactly like `applied` only when `result.version === (se?.baseVersion ?? 0) + 1`, otherwise leave the base (the next pull's merge reconciles); `stale` → set op back to `PENDING`, then `reconcile(ctx, def, result.current, String(seq), localRow?.data ?? null)` with the cross-space guard (the op is the `pending` the merge rewrites or pauses as `CONFLICT`, identical to the GitHub path). Loop continues while some op was rewritten to PENDING. A thrown network error: SENT ops back to `PENDING` with `error`, `handleHubError`, return. After success `Space.lastChangedAt` set and `emit(space.id, "pushed")`.

- [ ] **Step 1: Write failing tests** in `tests/hub-sync.test.ts`: `edit on olive reaches alice through push + pull (outbox empty, hub entity version 1)`; `concurrent edits to DIFFERENT entities: both applied, no stale, no conflict`; `same entity, different fields: one stale, three-way merged, retried in the same cycle, both fields present on both clients after sync, no SyncConflict`; `same field: SyncConflict OPEN with that field, op CONFLICT, nothing sent until resolveConflict(..., "mine")` then pushed and visible; `lost response (hub.dropNextResponse()): first push throws network, ops back to PENDING, second push gets duplicate, hub applied once (version 1), op gone, base correct` (Focus 4); `duplicate with a newer remote version leaves base untouched and a later pull converges`; `remote edit vs local delete → conflict with fields ["__deleted"]` and the reverse (Focus 5); `offline queue: hub stopped, three edits captured and stay PENDING; hub restarted, one sync sends them all`; `three-round cap: hub.alwaysStale(entity) leaves ops PENDING after exactly 3 push requests`; `write forbidden (member demoted to READER) → ops QUARANTINED, canWrite false`; `delete is pushed as DELETE op and arrives as tombstone`.
- [ ] **Step 2: Run** `npx vitest run tests/hub-sync.test.ts` — Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** `pushHub` per Interfaces; add `FakeHub.alwaysStale` and `FakeHub.setRole` if missing.
- [ ] **Step 4: Run** `npx vitest run tests/hub-sync.test.ts tests/team-sync.test.ts tests/review-fixes.test.ts` then `npm run typecheck && npm run lint` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub-client): hub push with per-op results, stale merge and retry`.

---

### Task 7: HubLink, live wiring, consistency delay

**Files:**
- Create: `src/lib/hub/link.ts`, `src/lib/hub/live.ts`
- Modify: `src/lib/sync/engine.ts` (`expectedConsistencyDelaySeconds` only)
- Test: `tests/hub-client/link.test.ts`, `tests/hub-sync.test.ts`

**Interfaces:**
- `link.ts` produces `interface SocketLike { onopen: ((e?: unknown) => void) | null; onmessage: ((e: { data: string }) => void) | null; onclose: ((e: { code: number }) => void) | null; onerror: ((e?: unknown) => void) | null; send(data: string): void; close(code?: number): void }`; `class HubLink { constructor(o: { origin: string; getToken: () => Promise<string | null>; connect?: (url: string, protocols: string[]) => SocketLike; timers?: { setTimeout; clearTimeout; setInterval; clearInterval }; random?: () => number; onChanged(spaceId: string, seq: bigint): void; onAccess(spaceId: string, action: "added"|"removed"|"deleted"): void; onTeam(reason: "member"|"role"): void; onHello?(spaces: { id: string; seq: bigint }[]): void; onState?(s: "live"|"reconnecting"|"offline"|"signed-out"|"removed"): void }); start(): void; stop(): void; get state(): ... }`. URL `ws(s)://<host>/ws`; protocols `["mergeport.v1", "bearer.<token>"]` (token never in the URL); default `connect` uses global `WebSocket`. Backoff `min(30_000, 1000 * 2^n)` × jitter `0.5 + random()` reset on `hello`; ping `{"t":"ping"}` every 25 s; `changed` debounced 100 ms per space (a burst → one `onChanged` with the highest `seq`); `bye` or close code `4403` → state `removed`, no reconnect; no token → `signed-out`, no connect.
- `live.ts` produces `startHubLive(o: { db: Db; engine: SyncEngine; client: HubClient; origin: string; getToken; connect?; timers?; random? }): { link: HubLink; live(): boolean; stop(): void }`: `onHello`/`onAccess`/`onTeam` → `client.me()` then `syncHubSpaces`; `onChanged` → `engine.syncSpace(space)` for the matching local space; while not `live` a 60 s interval calls `me()` + `syncSpace` for every HUB space (fallback poll); the engine's `hubLive` dep must read `live()`; `access removed|deleted` → `engine.revokeSpace`.
- `expectedConsistencyDelaySeconds(pollSeconds: number, hub?: { live: boolean })`: returns the existing `{ typical, worst }` unchanged when `hub` is undefined; with `hub`: `{ typical: 1, worst: 1, label: "about 1 s (live)" }` when live, `{ typical: 30, worst: 60, label: "up to 1 min (reconnecting)" }` otherwise. Return type gains optional `label?: string`.

- [ ] **Step 1: Write failing tests**: `link.test.ts` with a scripted fake socket + fake timers: protocols carry the bearer and the URL has no token; backoff sequence 1, 2, 4 … capped 30 s (`random: () => 0.5`→ ×1); backoff resets after `hello`; ping every 25 s; burst of five `changed` within 100 ms → one `onChanged` with the last seq; two spaces → two callbacks; code 4403 → `removed`, no timer scheduled (Focus 6); missing token → `signed-out`; `stop()` clears timers. `hub-sync.test.ts`: `live propagation: olive edits, calls syncSpace; hub emits changed; alice's live link syncs; alice has the edit in under 1000 ms of fake-timer/real time with no polling call` ; `socket down → fallback poll every 60 s picks the edit up`; `hub restart with clients connected: sockets dropped, link reconnects, cursor continues, edit made during the outage arrives`; `access removed over the socket purges alice's cached rows and quarantines unsent ops`; `access deleted purges the deleting admin's data too`; `flapping: ten changed + reconnects → never two concurrent syncSpace for one space` (spy on the engine `syncing` guard via call overlap); `newer hub schema refused: checkHubHealth throws kind "schema" and no Space is created`; `expectedConsistencyDelaySeconds(30)` equals its previous value, hub live → label "about 1 s (live)".
- [ ] **Step 2: Run** `npx vitest run tests/hub-client/link.test.ts tests/hub-sync.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `link.ts`, `live.ts`, the delay function, `FakeHub.socket` details if missing.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm test` — Expected: all pass, existing suites unchanged.
- [ ] **Step 5: Commit** `feat(hub-client): HubLink with backoff and debounce, live wiring, consistency delay`.

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `docs/architecture.md` (new section "Hub backend (client)": transport abstraction, cursor/snapshot, op results, live link, session store, what plan 3 must wire in `src/lib/local/runtime.ts`: `hub` factory, `startHubLive`, vault key path)
- Create: `C:\Users\migue\AppData\Local\Claude-Data\claude_pzs8sxrjxfjjc\side-session-notes\local_8671444b-398e-49ed-acd9-06640be02cc9\hub-client-handover.md` (exported names, signatures, known gaps) — outside the repo.

- [ ] **Step 1:** Write both documents from the code as it exists (grep exported names; do not invent).
- [ ] **Step 2:** Run `npm run typecheck && npm run lint && npm test` — Expected: all pass; `git diff main -- tests/team-sync.test.ts tests/review-fixes.test.ts` is empty.
- [ ] **Step 3: Commit** `docs: hub client architecture notes`.

---

## Self-review notes

- Spec coverage: transport abstraction/`Backend`/`HubClient` (T2, T4), pull cursor/410/snapshot/vanished (T5), push per-result and 3 rounds (T6), `HubLink` backoff/debounce/fallback/4403 (T7), `expectedConsistencyDelaySeconds` (T7), schema + unique index (T1), `HubSession` + key file (T3), purge on `access removed|deleted` (T5 revoke path, T7), HTTPS/loopback rule and `/health` schema/host/publicUrl checks (T2), privacy by request (T5), hub restart and cursor-lower-than-local (T5, T7). Not here by design: sign-in UI, profile switching, `HubTeamService`, `runtime.ts` wiring (plan 3).
- Spec's "newer hub schema refused by an older client" is `checkHubHealth` (T2) exercised in T7.
- Names used across tasks: `pullHub`, `pushHub`, `pullGithub`, `pushGithub`, `backendOf`, `handleHubError`, `syncHubSpaces`, `startHubLive`, `makeHubClient`, `FakeHub`, `HubError`, `HttpHubClient`, `checkHubHealth`, `openVault` — consistent as written.
