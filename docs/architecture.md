# Architecture

Mergeport is a local-first application. Each person runs it on their own computer, against their own SQLite database, authenticated to GitHub through the official GitHub CLI. A team shares Mergeport-owned data through private GitHub repositories. There is no server to deploy.

```
 your computer                                     GitHub
┌───────────────────────────────┐   gh api    ┌───────────────────────────┐
│ browser ── 127.0.0.1 ── Next.js │ ──────────▶ │ source repos (issues, PRs) │  your access
│            │                    │             ├───────────────────────────┤
│            ├─ SQLite profile    │ ◀────────── │ mergeport-<team>-workspace │  common space (private)
│            ├─ sync engine       │             │ mergeport-<team>-<space>   │  restricted spaces (private)
│            └─ outbox (durable)  │             └───────────────────────────┘
└───────────────────────────────┘
```

## Decisions

| Decision | Why |
| --- | --- |
| Loopback server, one SQLite file per `(host, GitHub user id)` | No infrastructure; accounts never share a database; a switch of the `gh` account locks the app instead of mixing data |
| GitHub is the source of truth for issues, PRs, reviews, labels | Fetched with the acting person's access and cached locally; Mergeport never claims to know more than the last successful fetch, and says how old it is |
| Mergeport-owned data lives in private "space" repositories | The repository **is** the audience. Privacy is a property of where data is stored, not of what the UI hides |
| One JSON file per entity, optimistic concurrency by blob SHA and non-force ref updates | Independent edits merge; same-record edits surface as a conflict; no server arbitration needed |
| Polling, not webhooks | A local app has no public address and must not need a tunnel. Consistency is eventual and the delay is published |
| Roles from GitHub permissions | An editable role string would be a forgery vector |
| GSAP only for board layout animation; everything else CSS | One owner per animated element; dnd-kit keeps the drag transform |

## Storage and migration

`src/lib/db.ts` opens SQLite through Prisma's better-sqlite3 adapter. `src/lib/db/migrate.ts` applies the SQL migrations in `prisma/migrations/` at startup, records them in `_mergeport_migrations` (and recognises Prisma's own table), and **refuses a database that has migrations this build does not know**, rather than guessing. SQLite limits shaped the schema: no scalar lists (labels are JSON), no JSON array filters (a lowercase `|a|b|` index string sits next to labels and assignees), no case-insensitive mode (LIKE is ASCII-insensitive).

Legacy Postgres installs are imported with `npm run migrate:from-postgres` (`docs/migration.md`).

## Authentication

`src/lib/github/exec.ts` runs the CLI: `spawn` with an argument array and no shell, a timeout and an `AbortSignal` on every call, a tracked set of live children (`terminateAllGh` at shutdown), a size cap on output, executable discovery (PATH, then the usual install folders), refusal of `.cmd`/`.bat` shims, and tree-kill on timeout or cancel. `src/lib/github/gh.ts` turns `fetch` into `gh api -i`, drops credential headers, passes bodies on stdin, and rejects request paths that look like options.

**Account binding (`src/lib/github/bound.ts`, `src/lib/local/profile-runner.ts`).** Application code reaches GitHub only through a runner bound to the profile's account. The CLI's globally selected account is never trusted, because a re-check before a call cannot close the gap between the check and the call. Instead the runner (1) asks for THIS account's token (`gh auth token --user <login>`), (2) verifies with that token that it belongs to the profile's numeric id, (3) runs every call with that token in the child's environment. A different id, a signed-out account or an old CLI block the call (an `IdentityError`, shown to the caller as a 401 with `x-mergeport-identity` and an actionable message); a 401 forgets the token; unreachable GitHub during verification behaves as offline. Inherited tokens are stripped from children and a token echoed on stderr is redacted.

`src/lib/local/identity.ts` reports, for display only, which account `gh` has selected. It answers from the last known value and refreshes in the background, so a page never waits on `gh`. A mismatch becomes a note in the layout; a missing or signed-out `gh` keeps the saved data readable and sends nothing. Scope honesty is in `docs/github-cli-setup.md`.

## Background discovery and offline behavior

Pages read the last known result from the local database (`DiscoveryCache`) and show how old it is. `src/lib/local/discovery.ts` refreshes in the background: one refresh per list at a time (callers share it), a deadline and an `AbortSignal` per attempt, at most three attempts with 2 s and 8 s backoff, then the scheduler retries after two minutes. A failure **keeps the saved list** and records why: offline, rate limited (waits for the reset), sign-in needed (waits for the person), or error. A failed refresh is never turned into an empty list or a "synced" state. Shutdown cancels refreshes and kills their `gh` processes; an attempt a crash interrupted is marked on the next start. The only live GitHub calls made while a page renders are ones the person just asked for (reviewing a team plan, opening a join link), each with a hard 12 s deadline.

## Local server boundary

- `scripts/start-local.ts` picks the profile, binds `127.0.0.1`, and opens a one-time launch link. The launch token is compared in constant time and works once.
- `src/proxy.ts` refuses any `Host` outside `127.0.0.1`, `localhost`, `[::1]` (DNS rebinding) and any state-changing request without a same-origin `Origin` or `Sec-Fetch-Site`, and marks every response `no-store`.
- The session cookie is `HttpOnly`, `SameSite=Strict`, minted only by the launcher link (or the demo sign-in), stored hashed.
- `/api/sync/events` is a server-sent-events stream used only for live refresh; `/api/sync/visibility` lets the page tell the engine whether it is visible so polling can slow down.

## Spaces and teams

A **space** is a private repository with a manifest `mergeport.json`:

```json
{ "schema": 1, "kind": "mergeport-space", "spaceId": "…", "teamId": "…", "teamName": "…",
  "spaceKind": "COMMON" | "RESTRICTED", "name": "…", "createdAt": "…", "createdBy": { "id": "…", "login": "…" } }
```

The common space is `mergeport-<team>-workspace`; a restricted space is `mergeport-<team>-<space>`. Entities live at `entities/<type>/<id>.json` as `{ schema, type, id, version, deleted, appliedOps[], updatedAt, updatedBy, data }`. The repository only ever holds Mergeport-owned entities: repository declarations, projects and boards, internal tasks, cross-repository milestones, routing configuration, waiting annotations and triage decisions.

**Create a team** (`src/lib/team/service.ts`): the app first shows the exact repository name, owner, visibility (always private), purpose and the permissions it will need, and does nothing until the person confirms. A name collision picks a new suffix; an existing repository is never overwritten. The manifest is written with stable ids.

**Invite**: native GitHub collaborator invitations, or a join link. A join link names a repository (`/join?repo=owner/name`); it is not a token and grants nothing. Invitation status is reported as pending, accepted, expired or failed.

**Join is explicit.** The teammate accepts GitHub's invitation and signs in as themself. Mergeport then discovers candidate repositories and shows, for each, the owner, visibility, the team and creator its manifest names, the access they would have, what it contains, what joining downloads (the manifest and shared entity files, nothing executed) and what it publishes (nothing by itself). Only the Join button, after a confirmation box, imports shared state and enables sync, and it re-validates everything and refuses if the GitHub repository id differs from the one shown. A candidate is joinable only if GitHub says it is private, not a fork and readable; its manifest is valid and of a supported schema; and, once in a team, it belongs to that team **and** sits under the same owner as the team's common space; for a personal-account owner the manifest's creator must be that owner; if it was joined before it must be the same repository by numeric id. A name prefix or a copied manifest alone is never enough. Public or untrusted repositories are rejected; the first join must be the common space.

**Restricted audiences get their own repository.** The common manifest does not list restricted spaces. Each person's app discovers the spaces their GitHub access reveals (candidates, then an explicit Join), and the owner's app aggregates what that owner can read. Data a person may not see is never written to a repository they can read.

**Roles** come from the `permissions` GitHub returns for the person on the common space (`refreshRole`): admin maps to team administration, push to editing, pull to read-only. Nothing in a JSON file or the local database is trusted for authority, so a forged `role: "admin"` changes nothing. Removing a collaborator in GitHub is how access is revoked.

**Source access** is separate: seeing a shared repository does not give a teammate its issues. Where a person cannot read the source repository the UI says "Source repository access required".

## Workspaces and hub profiles

A **profile** is one SQLite file for one `(host, GitHub account id, backend)`. `backend` is `github` or `hub-<fingerprint>`, where the fingerprint is the first 16 hex chars of SHA-256 over the normalized hub origin (`src/lib/local/backends.ts`; `http://` only for loopback). GitHub profiles keep their old folder name (`<host>-<accountId>`); a hub profile adds `-<backend>`. Two backends therefore never share a database, cache or outbox.

Two small registry files live in the Mergeport home (`src/lib/local/registry.ts`, atomic temp-file-then-rename writes). Neither holds tokens or sessions.

- `active.json`: `{ host, accountId, backend }`, the profile the launcher opens next.
- `hubs.json`: known servers, `{ origin, teamName, lastSignedInAs, addedAt }[]`, used by the switcher.

**Supervisor and control channel** (`src/lib/local/supervisor.ts`, driven by `scripts/start-local.ts`). The launcher owns the app child process. It listens on a loopback control port; the app gets the address through `MERGEPORT_CONTROL_URL` and authenticates each request with its own `MERGEPORT_LAUNCH_TOKEN`, which the supervisor compares (constant time) with the current child's token and refuses with 403 otherwise, so a previous child or anything that captured an old token cannot switch. Switching is fire-and-poll:

1. The app POSTs `/switch` `{ backend }` to the control channel. The supervisor first checks `resolveTarget`; a failure there is a 409 and nothing is killed. Otherwise it generates the one-time token and replies **202** `{ launchUrl, previousBootId }`, waits `killDelayMs` (default 400) so the response reaches the browser, kills the old child, then starts the new one. A different switch already running is also 409. `/api/local/switch` maps every launcher refusal to 409.
2. A boot failure AFTER the 202 has no HTTP error. The supervisor restores the previous child, so the browser sees a new `bootId` with a different backend and the overlay returns to `/`. If no child can be started at all, the overlay times out after 60 s with a banner. The launcher logs the failure through the supervisor's `switch-failed` event and exits when no child is left. If the old child cannot be killed (kill times out), the supervisor keeps its handle and refuses further switches ("The previous workspace did not stop") rather than start a second child.
3. The launcher, not the app, writes `active.json` in its `onSwitched` callback once the new child is up. Because that happens after the switch, `currentBackend()` and the switcher prefer `MERGEPORT_BACKEND` (set by the launcher for every child, including the first) and fall back to `active.json` only when it is unset (no launcher).
4. `SwitchingOverlay` (a portal over the current page, not a separate `/switching` route) polls `GET /api/local/ready`, which returns `{ bootId, backend }`. A new `bootId` with the target backend navigates to `launchUrl` (the new app consumes that one-time launch link); a new `bootId` with another backend returns to `/`. With `previousBootId` null, the first success before any error counts as the old process and a success after an error as the new one. While the old process is gone the poll simply fails and retries; after 60 s the overlay shows the timeout banner.

**Connect to a server** (sign-in card, `src/lib/hub/connect.ts`). Enter the hub address; the app normalizes it and checks `GET /health`, then runs the hub's GitHub device flow (user code and verification URL shown, polled until approved; cancel stops the poll). The hub returns a session token and the member's numeric GitHub id. `completeConnect` requires `gh` to be signed in as that **same numeric id** (and host), otherwise creates nothing. On success it creates the profile database, stores the session through the session port, marks the profile, upserts `hubs.json`, writes `active.json`, and the UI switches to it.

**Hub Team page.** In a hub profile `/team` is served by `HubTeamService` over a hub admin port: members with roles (owner, admin, member, reader), invite, role change, remove, and space membership including restricted spaces. A 401 from the hub asks to sign in again, a 403 says access was removed or refused, and connection state (live, reconnecting, offline, pending edits) comes from the link-status port. Authority is always the hub's answer; a cached "denied" is re-checked and cleared after mutations.

**Backend isolation.** `assertBackendMatch(config, space)` (`src/lib/local/backend-guard.ts`) refuses to open a `GITHUB` space in a hub profile and the reverse.

### Hub integration (done)

The hub UI was built against ports (`src/lib/hub/ports.ts`); `src/lib/hub/ports-impl.ts` now implements them on the real storage and the real hub API:

- `hubSessionPort` keeps the token encrypted in the profile's `HubSession` row (`src/lib/hub/session-vault.ts`, key file `key` beside the db) and `markProfile` writes `TeamConfig { mode: TEAM, backend: HUB, hubOrigin }`.
- `httpHubAdmin` speaks `hub/src/{auth-routes,admin-routes}.ts` (`POST /admin/invites { githubLogin, role }` resolves the login to its numeric GitHub id through `GET /users/{login}` with the OAuth App's Basic credentials and stores `invite.github_id`; sign-in matches an invite by id, by login only for legacy rows with no id; `POST /admin/spaces` answers `{ space }`).
- `hubLinkStatus` reads the running process's `HubLink` state (registered by `getEngine()` in `src/lib/local/runtime.ts`) plus the count of `PENDING`/`CONFLICT` outbox ops in hub spaces.
- `getEngine()` reads `TeamConfig`: on `backend = HUB` it builds the engine with an `HttpHubClient` and starts `startHubLive`; a GitHub profile keeps the GitHub store unchanged.
- `tests/hub-e2e.test.ts` runs two local clients against the real in-process hub (`tests/hub/harness.ts`).

Still open: `currentBackend()` in `src/lib/local/workspaces.ts` reads `MERGEPORT_BACKEND`/`active.json`, not `TeamConfig`; `assertBackendMatch` is not yet called from the `SyncEngine`.

### Manual verification (spec) not yet run

None of these has been run. Only automated tests with a fake hub exist (`tests/fake-hub.ts`, `tests/profile-switch.test.ts`).

- [ ] Hub behind Caddy with real TLS
- [ ] Two real GitHub accounts (owner and teammate)
- [ ] Invite the second account
- [ ] Second account joins
- [ ] Edit on one side, see it on the other
- [ ] Remove the member and confirm access ends

## Sync

Each person's database holds the working copy. `SyncEngine` (`src/lib/sync/engine.ts`) reconciles it with each space:

1. **Capture**: diff the local read model against the last synced base (`SyncEntity`) and write a durable `OutboxOp` per changed entity. Nothing is lost if the app closes.
2. **Pull**: conditional head check (ETag, `304` costs nothing), recursive tree, fetch only blobs whose SHA changed, then a **three-way merge** with base, local and remote. Independent field edits merge. Same-field edits open a `SyncConflict` that keeps both values.
3. **Push**: create blobs, a tree on the head just read, a commit, then a **fast-forward-only** ref update. If the ref moved (`HeadMovedError`) the loop pulls and retries. A lost response is detected by `appliedOps` in the file, so retries are idempotent and an operation is never applied twice.
4. **Conflicts** are resolved by the person (`mine` or `theirs`); neither version is discarded before then.
5. **Deletes** are tombstones (`deleted: true`), so a delete is a version like any other and cannot be resurrected by a stale copy.

Per-space state shown to the person: **Pending, Syncing, Synced, Offline, Conflict, Access revoked** (plus Rate limited, Update needed, Read only).

**Consistency delay (published in the UI).** Polling base is 30 s while the app is open and visible (configurable, minimum 15 s). Unchanged polls back off (×2 per 4 unchanged, capped at 10 min) with ±20% jitter; a hidden tab or closed app polls rarely or not at all. A teammate's change typically appears within about `poll/2 + 2` s when active. It is **not real time**.

**Rate limits.** Two lanes with separate budgets: the coordination lane (`engine.tick()`) and the source-repository job queue. Exhausting one never starves the other. `Retry-After` / reset times set `rateLimitedUntil`.

**Revoked access.** On `403/404` for a space the engine stops reading and writing it, quarantines unsent operations (`QUARANTINED`), and purges cached rows that came from it. The person can retry the sent operations if access returns or discard them. Git history on GitHub is not erased and the UI says so.

**Schema skew.** A space or entity file with a newer schema is read-only (`SCHEMA_NEWER`); unknown entity files are skipped and never rewritten by an older client.

## Hub webhook relay (server)

The hub can relay GitHub webhooks (`hub/src/webhook-routes.ts`, `hub/src/settings.ts`, `GithubRelay` in `hub/src/notify.ts`). `POST /webhooks/github` is authenticated only by the HMAC-SHA256 signature (`X-Hub-Signature-256`) over the raw body (1 MiB cap) with the GitHub App's webhook secret, stored in the hub's `setting` table (owner-only `PUT`/`DELETE /admin/github-webhook`; env fallback `MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET`). A verified delivery is parsed in memory, deduplicated by `X-GitHub-Delivery` for 10 minutes, and sent as `{t:"gh",repoId,event,delivery,payload}` to each WebSocket connection that listed the repository in its `{t:"watch",repos}` message and may see it (public repository, the member owns it, or it is shared through a space the member can read). Nothing from a delivery is stored or logged, and the apps keep their 15-minute cycle as the safety net. Design: `docs/superpowers/specs/2026-10-30-github-webhook-instant-updates-design.md`.

## Hub backend (client)

A team may sync through a Mergeport hub (HTTP plus WebSocket) instead of a GitHub coordination repository. This section describes the client half that exists in `src/lib/hub/` and `src/lib/sync/engine.ts`. It is not wired into the running app yet (see "What plan 3 must wire").

**Transport abstraction.** `src/lib/hub/types.ts` defines `HubClient` (`me`, `pull(spaceId, since)`, `snapshot(spaceId)`, `push(spaceId, ops)`) and `Backend = { kind: "github"; store } | { kind: "hub"; client }`. `SyncEngine.backendOf(space)` picks the backend from `Space.backend` (`GITHUB` or `HUB`). `pull` and `push` dispatch on `space.backend` to `pullHub`/`pushHub` or `pullGithub`/`pushGithub`; the GitHub path is the former `pull`/`push` moved unchanged, and `tests/team-sync.test.ts` and `tests/review-fixes.test.ts` are untouched. `EngineDeps` gained `hub?: (space) => HubClient` and `hubLive?: () => boolean`; without `hub`, a hub space throws "No hub client configured". `HttpHubClient` (`src/lib/hub/client.ts`) is the implementation; `normalizeHubOrigin` accepts only https, or http on loopback.

**Pull by cursor.** `Space.hubCursor` (BigInt) is the last hub `seq` applied. `pullHub` pages `pull(spaceId, since)` while `more` is set. Only the newest event per entity is applied (the event carries the whole entity), through the same three-way merge and guards as a GitHub pull. The cursor is stored only after entities are applied; if one entity cannot be applied the cursor stays just before it so the next pull retries.

**410 and snapshot resync.** The hub answers `410` when the cursor predates its retained history; `HttpHubClient.pull` maps that to `"gone"`. `pullHub` also resyncs when the hub answers with `seq` lower than the local cursor (hub restored from backup or rebuilt). Both cases fetch `snapshot(spaceId)`, apply it, and set the cursor to the snapshot `seq`. Entities tracked locally (`SyncEntity`, not deleted) but absent from the snapshot are treated as vanished and removed through the same path as a remote delete. **Restored hubs.** The hub also answers `410` with `reason: "history"` when the op the client last read at its cursor (`Space.hubCursorOp`) is not the op the hub holds at that position, and every pull and snapshot carries a per-process `epoch` (`Space.hubEpoch`). A snapshot taken because of a restore (`restored: "certain"` for a seq or history mismatch, `"suspected"` for a new epoch) first runs `collectRestoreLoss`: entities with unsent edits are counted as kept and merged by `reconcile` as usual, and clean local copies about to be replaced are written to a `HubRestore` row (capped detail, `resend` only for copies provably newer than the hub's). After a suspected restore only provable regressions are recorded, because a restarted hub that is simply ahead is an ordinary remote edit. The Sync page lists open `HubRestore` rows with "Send my copies again" (`resendRestored`, ordinary PENDING ops against the hub's current versions) and "Keep the server's version" (`dismissRestored`); the top bar shows them like conflicts.

**Push with per-op results.** `pushHub` sends pending `OutboxOp`s as `Op[]` (`opId` is the outbox id, so a retry is idempotent) and gets one `OpResult` per op: `applied` (settle base at the returned version, delete the op), `duplicate` (already applied, delete the op), `stale` (the hub returns `current`). A missing result puts the op back to PENDING. For `stale` the engine reconciles `current` with the local row (three-way merge), which rewrites the op, and retries immediately, up to **3 rounds** per cycle so a hot entity cannot spin. A `stale` without `current` just rebases `baseVersion`; a `current` with a newer schema blocks the entity (`SCHEMA_NEWER`). A thrown error returns ops to PENDING; a failure while recording results does too (never stranded in SENT).

**Errors.** `HubError` has `kind` (`network`, `auth`, `forbidden`, `not-found`, `rate-limited`, `schema`, `unknown`), optional `status` and `retryAfterSeconds`. `handleHubError`: network sets "offline" and backs off; auth sets "Sign in to the server again"; `not-found` on read or write, and `forbidden` on read, revoke the space (same purge and quarantine as GitHub); `forbidden` on write drops to read-only and quarantines unsent ops; `rate-limited` sets `rateLimitedUntil`.

**Live link.** `HubLink` (`src/lib/hub/link.ts`) owns one WebSocket at `<origin>/ws` (http becomes ws). The token travels only in the subprotocols `["mergeport.v1", "bearer.<token>"]`, never in the URL. Reconnect backoff is `1000 * 2^failures` ms, times a `0.5 + random()` jitter, with the result capped at 30 s (the cap includes the jitter); state is `reconnecting` for the first failures and `offline` from the third. A ping `{t:"ping"}` is sent every 25 s. Messages: `hello` (resets backoff, state `live`, `onHello`), `changed` (debounced per space for 100 ms into one callback with the highest seq), `access` (`added`/`removed`/`deleted`), `team`, `bye`. Close code `4403` means this member was removed: state `removed`, no reconnect. `bye` with reason `shutdown` is an ordinary drop and reconnects; any other `bye` reason is treated as removal. A missing token gives state `signed-out`. Malformed messages are ignored.

**`startHubLive`.** `src/lib/hub/live.ts` wires a `HubLink` to the engine and returns `{ link, live(), stop() }`. On `hello` it runs `me()` + `syncHubSpaces` and syncs every hub space. On `changed` it syncs that space (one cycle at a time per space, one extra queued if a notification arrives mid-cycle, a few short retries while the cursor has not reached the announced seq). `access added` refreshes spaces; `removed`/`deleted` revokes that space; state `removed` revokes every hub space. A **60 s poll is always on**: while the link is not live it refreshes and syncs all hub spaces; while live it only syncs spaces that look unhealthy (`lastError` set, `rateLimitedUntil` expired, or `hubCursor` below the last announced seq), so a failed cycle or exhausted retry cannot leave a live space stale. On start, ops left `SENT` for hub spaces are reset to `PENDING` (the hub answers `duplicate`). `engine.tick()` skips hub spaces while `hubLive()` is true, and otherwise polls them with a 60 s base that `schedule()` backs off; `expectedConsistencyDelaySeconds(poll, { live })` returns "about 1 s (live)" or "up to 1 min (reconnecting)".

**Spaces.** `syncHubSpaces(db, engine, me)` creates or updates local `Space` rows from `GET /me`, revokes spaces the hub no longer lists, restarts the cursor at 0 for a space that comes back after revocation, and upserts `TeamConfig` (`backend: HUB`, `commonSpaceId`). `canAdmin` is always false for hub spaces. `checkHubHealth(origin, supportedSchema = 1)` reads `/health` and refuses a hub with a newer schema, a `publicUrl` that differs from the typed address, or a GitHub host other than `github.com`.

**Encrypted session store.** `src/lib/hub/session-vault.ts`. `openVault(keyFile)` creates or reads a 32-byte key file (written private, hard-linked into place so concurrent creators agree; best-effort `icacls` restriction on Windows; a wrong-sized file is an error, never silently replaced). The vault encrypts with AES-256-GCM and a random 12-byte IV, stored as `v1.<iv>.<tag>.<data>` (base64). `saveHubSession` / `loadHubSession` / `clearHubSession` keep one `HubSession` row (`id = "session"`: `origin`, `cipher`, `githubId`, `login`). `loadHubSession` returns `null` when decryption fails (key lost or changed), which means signing in again. The key file in the profile directory (`key`, beside `mergeport.db`) protects the hub session token against accidental disclosure: copying the database on its own, a backup of the database alone, or a log or bug report that includes it, none of which can decrypt the token without the key. It does not protect against another process running as the same OS user, which can read both files just as Mergeport does. The upgrade path with real isolation is the operating system keychain (Keychain, Credential Manager, Secret Service), which the project has not adopted because it needs a native dependency. The key file is never copied or exported with a profile: `saved-profiles.ts` only reads `mergeport.db`, and `scripts/migrate-from-postgres.ts` writes a fresh database. "Sign out of this server" on the hub Team page deletes the `HubSession` row (`hubSessionPort.remove` -> `clearHubSession`).

**Schema changes** (migration `20261030130000_hub_client`). Enums `SpaceBackend` and `TeamBackend` (`GITHUB`, `HUB`); `Space.backend`, `Space.hubSpaceId` (empty for GitHub), `Space.hubCursor`; the unique key on `Space` becomes `[backend, repoOwner, repoName, hubSpaceId]`; `TeamConfig.backend`, `TeamConfig.hubOrigin`; table `HubSession`. Existing rows default to `GITHUB`.

**Test strategy.** The hub server is not in this repository, so `tests/hub-client/fake-hub.ts` (`FakeHub`) is a real local HTTP server plus in-memory `FakeSocket`s that implements `/health`, `/me`, entities pull (with `410`, paging, `seq` regression), snapshot, ops (per-op results, stale), and failure injection. `tests/hub-client/harness.ts` (`makeHubClient`) builds an isolated database, `HttpHubClient`, engine and optional `startHubLive` per simulated member. Link timing tests use manual timers (`manual-timers.ts`). Suites: `client`, `dispatch`, `link`, `schema`, `session-vault`, `spaces` in `tests/hub-client/`, and `tests/hub-sync.test.ts` for pull, push, live and revocation end to end.

### What plan 3 must wire

Nothing below exists in the running app yet; the engine and `src/lib/hub/` are complete and tested only through the harness.

- `src/lib/local/runtime.ts` `getEngine()`: pass `hub: (space) => client` (an `HttpHubClient` for the saved origin whose `getToken` reads the stored session) and `hubLive: () => live?.live() ?? false` into `EngineDeps`. Today it passes only `store`.
- Call `startHubLive({ db, engine, client, origin, getToken })` after sign-in and at start-up when a session exists; keep the handle and call `stop()` on sign-out or profile switch.
- Vault key path: `<profile dir>/key`, passed to `openVault`.
- Load the session with `loadHubSession(db, vault)` at start; `saveHubSession` after sign-in; `clearHubSession` on sign-out. `null` from load means sign in again.
- Call `checkHubHealth(origin)` when the user connects to a hub, before storing anything.
- Call `syncHubSpaces(db, engine, await client.me())` after connect (live does it on `hello`).
- A `HubTeamService` (team/member management against the hub) does not exist; `TeamService` is GitHub-only.
- Sign-in UI, profile switching, and surfacing `HubLinkState` / `expectedConsistencyDelaySeconds(.., { live })` in the UI.

### Hub client limitations

- A stale op that can never merge (cross-space or blocked entity) is re-sent every cycle, as in the GitHub path.
- Conflict ops are not considered when deciding that an entity vanished from a snapshot (mirrors GitHub).
- Session key storage needs a filesystem that supports hard links.
- Hub spaces are never admin spaces locally; role and membership come from the hub.

## Scheduler

`src/lib/jobs.ts` is the local job queue; `src/lib/local/scheduler.ts` runs it from `instrumentation.ts`. A recurring job (`reconcile.all`) carries its own `intervalMs`; the runner re-queues it after each run. A trigger that arrives **while a run is in flight** sets `dirty`, and the run requeues immediately instead of the trigger being swallowed. This fixes the original defect, where a self-reschedule under the same dedupe key during `RUNNING` was dropped and the job was then marked `DONE`. After a restart a recurring job runs once and then waits a full interval.

## Authorization of local data

`src/lib/authz/viewer.ts` is the single place visibility is defined. `repoWhere(viewer)` is a SQL filter evaluated per request, not a cached list. Locally a person always has full capabilities over what they track; for repositories that arrived through a space, access derives from that space's membership. Missing and hidden both produce the same `NotFoundError`; `ForbiddenError` is used only when the item is visible and the capability is not. Planning cards linked to a GitHub item inherit that repository's visibility; a hidden blocker still blocks and appears as an opaque marker.

## Local worktrees

Read-only, on this computer only. Folders are mapped explicitly; scans run a fixed allow-list of read-only `git` subcommands as argument arrays (no shell, no hooks); only branch names, paths and counts of changed files are kept, never contents or diffs. Snapshots stay in the local database and are never written to an outbox or a space. Sharing worktree data with teammates is not implemented.

## Review waiting

`src/lib/domain/review.ts` derives the waiting state from real review requests and review results plus the resolved routing rule. A comment or a label change never counts as approval. Approvals on an older commit are stale. GitHub's requested-reviewers endpoint has no timestamp, so "waiting since" is when Mergeport first saw the request (labelled "request first seen").

## Theme and motion

See `DESIGN.md` ("Dark theme", "Motion") and `docs/motion.md` (motion matrix, tokens, ownership rules, evidence, reference ledger). The theme is a cookie rendered into `<html data-theme>` on the server; tokens are defined once and overridden for dark.

## Limitations (stated, not hidden)

- Eventual consistency by polling; the delay is published, not eliminated.
- Git history in a coordination repository keeps everything ever written there. Revocation stops access and removes local cache; it cannot rewrite what a former collaborator already read.
- A repository belongs to one audience (one space) at a time, and a project shared through a space may only link repositories shared through that same space.
- Candidate trust is as strong as GitHub's owner, visibility and permission data plus the manifest checks. For an organization-owned space the manifest's creator can be any member who can create repositories there; the card shows who created it and warns when it is not the team owner, but Mergeport cannot prove more than that.
- Reading a token: Mergeport must read the profile's token from `gh` into memory to bind calls to the account. It is never stored, logged, put in an argument, or sent to the browser, but it is in the server process's memory and in each `gh` child's environment while a call runs.
- Two live GitHub calls can still be awaited while a page renders, both user-initiated and both capped at 12 seconds: reviewing a team plan and opening a join link. Everything else renders from saved state.
- Forced termination (End task, `taskkill /F`, a crash, power loss) cannot run cleanup code, so graceful cleanup cannot be guaranteed after it. Ctrl+C can, and was exercised. After a forced kill SQLite stayed consistent and unsent edits were intact; an interrupted refresh is marked on the next start.
- Background sync runs only while the app is running.
- `repo` is a broad GitHub scope; see `docs/github-cli-setup.md`.
- Real GitHub was exercised only read-only (see below). SSO, throttling, invitations and every write remain simulated.

## Verification record

Run on 29 Oct 2026, Windows 11, Node 24.12, `gh` 2.102.0 with one existing signed-in account. Four categories, kept apart:

**Verified against real GitHub (read-only, through the application's own pinned-identity adapter; `npm run test:live`, opt-in).** Nothing was written, no repository or invitation was created, the selected `gh` account was not switched, no login was started, and no private repository was inspected beyond being counted by discovery (names are not printed or stored).

| Check | Result |
| --- | --- |
| Pinned identity | `GET /user` through the bound runner returned the profile's numeric id; a profile pinned to a different id was blocked (`mismatch`, 401) with nothing sent |
| Public repository `cli/cli` | metadata, 100 issues and pull requests (page 1), 32 pull requests, reviews on 13 of the first 15 pull requests (23 reviews), pull request detail, 259 branches |
| Discovery | the account's repositories listed (68: 20 public, 48 private), on one page |
| Pagination | `rel="next"` followed across 3 real pages, 300 unique items |
| Rate limit | real `x-ratelimit-limit/remaining/reset/resource/used` headers present (core, limit 5000); the adapter records them |
| Conditional request | `If-None-Match` with the real ETag returned 304 through `gh` |
| Errors | missing repository and missing pull request map to `not-found` |
| Launched copy | an isolated copy launched with the documented command against this account (temporary profile home): page rendered in 70 ms, background discovery completed ("Up to date", 68 repositories), Settings showed "Signed in with the GitHub CLI" |

**Verified locally (real processes, browser, files on this machine).**

| Check | Result |
| --- | --- |
| `npx tsc --noEmit`, `npx eslint .`, `npm run build` | all clean after the last edit (build: no warnings) |
| Unit and integration suite (`npx vitest run --maxWorkers=4`) | 18 files, 222 tests passing; the 5 live tests are skipped unless `MERGEPORT_LIVE=1` |
| Reproducible install | isolated copy without `.env`, databases, `node_modules`, `.next` or `src/generated`: `npm ci` in 16 s (659 packages), one `better-sqlite3` 13.0.3 loaded from its shipped `prebuilds/win32-x64.node`, production build clean, `npm run local` built on first run and served |
| Ctrl+C through the real Windows console (`npm run local`, hidden console, `GenerateConsoleCtrlEvent`) | idle: server and children gone, port released; with discovery stalled and a hung `gh` child running: the hung child and the whole tree gone; only npm's `cmd.exe` batch wrapper waiting on "Terminate batch job (Y/N)?", which was ended by the test (only its own process) |
| After shutdown | `PRAGMA integrity_check` = ok, the pending outbox edit still `PENDING`, restart served in 63 ms, an interrupted refresh was recovered and completed |
| Forced kill of the launcher process | no processes were left in this run, SQLite integrity ok, outbox intact, discovery row left `RETRYING` (recovered on the next start). This does not show cleanup is guaranteed |
| Account binding, subprocess handling, offline behavior, joining, concurrent migrations | as listed in the test table below (real child processes against a fake `gh`) |

**Verified with mocks (labelled simulated).** A fake `gh` script and an in-process GitHub simulation stood in for: multi-account switching and credential revocation, SAML SSO, throttling and `Retry-After`, invitations and collaborator permissions, repository deletion and recreation, newer-schema spaces, and every write.

**Still unverified or blocked.** Any write to GitHub; a private repository (needs your explicit selection); real SSO, throttling, invitations and a real second account; multi-page discovery for an account with more than 100 repositories (the real list fit on one page; paging itself was proven on a different endpoint); `gh auth login` on Windows (never started automatically); macOS and Linux; touch devices; screen readers.

Earlier round (local-first build, light and dark, motion): a read-only adversarial review confirmed and a regression test now covers: tombstones or files from one space deleting or renaming an entity in another; a project in a wider space publishing a narrower space's repository and issue titles; a malformed file stalling sync; an open conflict silently settled; a newer-schema file overwritten; forged or replaced manifests; stale permission checks; quarantined edits re-captured; and the Postgres importer carrying hidden content. An interface, accessibility and motion review repaired the drag handle semantics, focus after a Move, live-region roles, the tab pill, refresh storms, an in-shell error boundary and a bounded Team page. Browser testing found a launcher redirect that dropped the session cookie and a missing sign-out route.

This round's defects (found by testing, not only by reading) were:

1. Writes could run as the newly selected account for up to the identity cache window (now bound to the profile's account).
2. Discovery auto-joined matching private repositories (now candidates plus an explicit confirmed Join, with owner, team, manifest and repository-id checks).
3. The Team and Connect pages waited on `gh` (now rendered from saved state with background refresh).
4. Migrations raced when several processes started at once (now one transaction per migration, re-checked after the lock).
5. A dead transport surfaced through Octokit as a generic error and any `TypeError` was shown as "offline" (now only real fetch failures are offline; bugs are errors).
6. The identity check spawned `gh` every five seconds (removed).

Real-account read-only verification and the defects it found are in `docs/real-github-verification.md`. Not verified, and not claimed: invitation behaviour, SSO, org policy and a real multi-account `gh auth switch`; `gh auth login` on Windows; the launcher's Ctrl+C path; touch devices; screen readers.

Test files:

| File | Covers |
| --- | --- |
| `tests/scheduler.test.ts` | Recurrence over 3 cycles with fake time, resume, crash/restart, duplicate scheduling, concurrent workers |
| `tests/team-sync.test.ts` | Two isolated clients with separate databases against a simulated GitHub: live propagation, concurrent and same-record edits, duplicate retries, offline and reconnect, deletion, restart, schema mismatch, revoked access, rate-limit exhaustion, owner global view vs two members, privacy of the common repository, forged roles, mocked create/invite/join |
| `tests/access.test.ts`, `tests/actions.test.ts` | Viewer-scoped visibility, forged ids, revocation, GitHub write capabilities, sessions, redirects |
| `tests/local-features.test.ts` | Planning concurrency, manual waiting, worktree scan privacy and cleanup |
| `tests/gh.test.ts`, `tests/local-guard.test.ts` | `gh` transport and identity, loopback guard, theme preference |
| `tests/identity-binding.test.ts` | Account switches before, during and between queueing and retry; credentials out of arguments; inherited tokens; offline vs blocked |
| `tests/gh-process.test.ts` | Real subprocess behaviour: arguments, stdin, timeout, cancel, tree kill, shutdown, discovery, real `gh --version` |
| `tests/discovery.test.ts` | Saved-list rendering, offline/rate-limit/auth states, retry and backoff, dedupe, shutdown, restart recovery, transport classification |
| `tests/join-consent.test.ts` | Candidates, explicit confirmed join, trust rules, forged and look-alike spaces, replaced repositories |
| `tests/migrations-concurrent.test.ts` | Twelve processes migrating one database at once |
| `tests/review-fixes.test.ts` | Cross-space tombstones and file takeover, poisoned files, wrong-repository manifests, conflicts that must stay open, newer-schema files, quarantine, shared-audience linking |
| `tests/migration.test.ts` | Postgres import: visibility, no credentials, no sharing, rebuilt indexes |
| `tests/sync.test.ts`, `tests/connector.test.ts`, `tests/domain/*` | Source sync idempotency, git access, review/planning/fork logic |
