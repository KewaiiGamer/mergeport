# Hub server: a self-hosted coordination backend

Date: 2026-10-29. Status: draft for builder review.

## Intent

Today a team shares Mergeport-owned data (projects, boards, tasks, comments, routing, waiting annotations, triage decisions, fork mappings, repository declarations) through private GitHub repositories: one JSON file per entity, pushed as commits, polled every 30 s. That design was chosen to avoid running anything. It is now considered unacceptable for the team that uses it: delivery is slow (seconds to minutes), each push costs several REST calls against a 5000/h budget, the repository grows forever, and deletion is not real.

This design adds a second coordination backend: a small **hub** service the team runs on its own VPS. The hub holds the shared data in its own database, is the single authority for it, and pushes changes to every connected client at once. GitHub stops hosting entity files when a hub is used.

The GitHub-repository backend stays exactly as it is and remains available. A person chooses, at first run and later from inside the app, whether their shared data lives on a hub or in GitHub repositories.

## Goals

- Live propagation: an edit on one computer reaches every other connected teammate within about a second, with no polling in the normal case.
- Offline edits keep working: edits made while the hub is unreachable queue locally and are sent on reconnect; conflicts (the rare case) are resolved with the existing mine/theirs flow.
- The hub never holds a GitHub token with repository access. Issues, pull requests, reviews and checks keep coming from each person's own `gh`, into their own local SQLite, as now.
- Identity on the hub is a verified GitHub account (numeric id), through a GitHub OAuth App the hub operator registers.
- First run offers "Connect to a server" next to the existing "Use GitHub". A person can switch between the GitHub mode and any saved server from inside the app.
- Privacy keeps its current meaning: a restricted audience's data is never sent to a person outside that audience, enforced by the hub, not hidden by the UI.

## Non-goals

- Moving Mergeport itself to the server. The app stays local; the hub is data and notification only, and has no UI beyond a health page.
- Hosting GitHub data (issues, PRs, comments, diffs) on the hub, or letting the hub call GitHub on a member's behalf for anything other than identity.
- Sharing local worktree data.
- Migrating an existing GitHub-repository team to a hub, or the reverse, in this iteration. (Each backend is a separate data set; see "Switching".)
- Multi-team hubs. One hub serves one team.
- Federation between hubs, or a hub talking to GitHub repositories.

## Anti-goals (what would make this a failure even if it works)

- Any path where the hub, or its operator, can obtain a member's `gh` token or any `repo`-scoped token.
- Weakening the GitHub mode: it must keep passing its existing tests, unchanged in behaviour.
- A client that must be online to render pages or make edits.
- A hub whose authorization trusts a role or audience claim written by a client.

## Constraints

- Node 24, TypeScript, same repository. The hub is a second entry point, not a second repository.
- Free to run: a single process on a small VPS, no managed services. Its database is SQLite (better-sqlite3, WAL mode), the same engine the client already ships prebuilt; nothing is compiled during install.
- The hub must sit comfortably behind a reverse proxy (Caddy, nginx) that terminates TLS. The client refuses plain `http://` hub URLs except for loopback addresses (`127.0.0.1`, `localhost`, `[::1]`), which exist for development and tests.
- The hub needs exactly two secrets from its operator: the GitHub OAuth App client id and client secret. Everything else it generates itself.

## Architecture

### Where things live

| Data | GitHub mode (unchanged) | Hub mode |
| --- | --- | --- |
| Shared Mergeport entities | JSON files in private GitHub repositories | Rows in the hub's SQLite; a local cache of them in the client's SQLite |
| GitHub issues, PRs, reviews, checks | Local SQLite, fetched by `gh` | Same |
| Worktrees, local filters, theme | Local only | Same |
| Who may read/write which space | GitHub repository permissions | Hub membership and space ACL tables |
| Identity | `gh` numeric account id | `gh` numeric account id locally; GitHub OAuth (numeric id) on the hub; the two must match |

### Profiles and switching

Today one SQLite profile exists per `(host, GitHub user id)`, at `~/.mergeport/profiles/<host>-<id>/mergeport.db`. A profile has exactly one team mode (`TeamConfig.mode`: PERSONAL or TEAM) and its spaces are GitHub repositories.

Change: a profile is keyed by `(host, GitHub user id, backend)` where backend is `github` (the existing layout, path unchanged, so nothing migrates) or `hub-<fingerprint>` for a hub, the fingerprint being the first 16 hex characters of SHA-256 of the normalized hub origin. Each profile has its own SQLite file, its own cache of GitHub data, and its own shared data. Switching backend means switching profile.

This is the builder's simplest safe option: shared entities from two backends can never mix, every existing query keeps working with no `backendId` column, and the GitHub cache is just re-fetched per profile (a cost in time and rate limit on first switch, accepted).

The launcher (`scripts/start-local.ts`) and the running app learn which profile is active from a small file `~/.mergeport/active.json` (`{ "host", "accountId", "backend" }`). The launcher picks the profile recorded there for the signed-in account; with none, it opens the `github` profile as today. A new file `~/.mergeport/hubs.json` lists saved hubs: `{ origin, teamName, lastSignedInAs: { id, login }, addedAt }`. No tokens live in it.

**Switching inside the app.** A "Workspace" switcher in the top bar lists "GitHub (repositories)" and every saved hub, with the active one marked, plus "Connect to a server…". Choosing another entry writes `active.json`, then the **launcher restarts the Next child** on the other profile file: `scripts/start-local.ts` stays alive as a supervisor, the app asks it to switch through a local control channel (a file-descriptor pipe or a loopback request carrying the launch token), the supervisor stops the child, starts a new one with `MERGEPORT_DB` pointing at the other profile and a fresh launch token, and the browser is redirected to the new launch link. The page shows "Switching workspace…" for the few seconds it takes. Switching must not require the person to re-run `npm run local`.

This is a deliberate choice over an in-process database swap: `db` is a module-level constant imported by about 70 files, and a live swap would need a proxy over the Prisma client plus teardown of the scheduler, the hub link, Next's module caches and the old SQLite handles (Windows locks the file). A child restart is a fraction of that work and cannot leak data between profiles.

### Hub session token storage

A hub session token is a secret. It is stored in the operating system credential store through the `gh`-independent `keytar`-style approach already available to Node… which the project does not have and should not add a native dependency for. Instead: the token is stored in the profile SQLite file for that hub, in a table `HubSession`, encrypted with a key derived from a random per-profile secret file `~/.mergeport/profiles/<dir>/key` created with mode `0600`. On Windows the file's ACL is restricted to the current user. This matches the security level of the existing SQLite profile (local file, local user). The key file in the profile directory (`key`, beside `mergeport.db`) protects the hub session token against accidental disclosure: copying the database on its own, a backup of the database alone, or a log or bug report that includes it, none of which can decrypt the token without the key. It does not protect against another process running as the same OS user, which can read both files just as Mergeport does. The upgrade path with real isolation is the operating system keychain (Keychain, Credential Manager, Secret Service), which the project has not adopted because it needs a native dependency. The key file is excluded from anything that copies or exports a profile, and signing out of the server deletes the `HubSession` row. The token never enters `hubs.json`, logs, the browser, or a space.

### The hub service

Entry point `hub/` directory in the repository (`hub/src/…`, `hub/package.json` is **not** separate: the root `package.json` gains `"hub": "node --import tsx hub/src/main.ts"` and `"hub:build"`). The hub is plain Node: `node:http` plus the `ws` package for WebSocket, Prisma with its own schema `hub/prisma/schema.prisma` and its own migrations, SQLite file at `MERGEPORT_HUB_DATA/hub.db`.

Environment:

```
MERGEPORT_HUB_PORT=8787
MERGEPORT_HUB_DATA=/var/lib/mergeport-hub
MERGEPORT_HUB_PUBLIC_URL=https://hub.example.com   # what clients type; used in the health page and OAuth callback check
MERGEPORT_HUB_GITHUB_CLIENT_ID=…
MERGEPORT_HUB_GITHUB_CLIENT_SECRET=…
MERGEPORT_HUB_TRUST_PROXY=true                      # read X-Forwarded-* from the reverse proxy
```

The hub binds `0.0.0.0` only when `MERGEPORT_HUB_TRUST_PROXY=false` and `MERGEPORT_HUB_PUBLIC_URL` is `https://`; otherwise it binds `127.0.0.1` and expects the proxy. It refuses to start without both GitHub OAuth values.

#### Hub schema

```
Team            id, name, createdAt, ownerGithubId
Member          githubId (pk), login, name, avatarUrl, role (OWNER|ADMIN|MEMBER|READER), status (INVITED|ACTIVE|REMOVED), invitedBy, invitedAt, joinedAt
Invite          id, githubLogin (lowercase), role, createdBy, createdAt, expiresAt, usedAt     -- invitation by username, resolved to a numeric id at first sign-in
Space           id, kind (COMMON|RESTRICTED), name, createdAt, createdBy, seq (bigint, per-space monotonic)
SpaceMember     spaceId, githubId, canWrite                                                      -- restricted spaces only; COMMON = every ACTIVE member
Entity          spaceId, type, entityId, version, deleted, data (json), updatedAt, updatedBy, seq -- current state, one row per entity
EntityEvent     spaceId, seq (pk with spaceId), type, entityId, version, deleted, data, opId, actorGithubId, at
Session         id (random 32 bytes, stored hashed), githubId, createdAt, lastSeenAt, expiresAt, clientName
```

`EntityEvent` is the change log clients pull by cursor. It is pruned: events older than 30 days and older than every active session's cursor are deleted; a client whose cursor is older than the retained log does a full resync of that space (the client handles the `410 gone` answer by re-listing).

`Entity.data` keeps the same shape as today's entity files (`data` from `EntityFile`; `schema`, `type`, `id`, `version`, `deleted`, `appliedOps`, `updatedAt`, `updatedBy` are columns or derived). The `appliedOps` list is kept as the last 50 op ids per entity, exactly as the GitHub backend does, so a lost response never applies an op twice.

#### Authorization on the hub

- Every request carries `Authorization: Bearer <session>`; the hub looks up the hashed token, requires `Member.status = ACTIVE`, and refuses otherwise with 401 (no session) or 403 (removed).
- COMMON space: readable by every ACTIVE member; writable by role MEMBER or higher.
- RESTRICTED space: readable only by rows in `SpaceMember`; writable only with `canWrite`.
- Team administration (invite, remove, change role, create or delete a restricted space, change its members): ADMIN or OWNER. Only the OWNER can transfer ownership or change another ADMIN. The OWNER cannot be removed.
- The hub never reads a role or audience from a request body. Clients send entity data only.
- A removed member's sessions are revoked immediately; their open WebSockets are closed with code 4403.
- Every ACTIVE member may see the member list with roles (it comes in `/me`), as GitHub collaborators can see each other today. Changing it needs ADMIN+.
- Sessions are **sliding, 30 days**: `expiresAt` moves forward on every authenticated request; an unused session expires. On 401 the client keeps its queued ops, shows "Sign in to the server again" on the Team page and the switcher, and runs the device flow again; ops are sent once the new session exists. A removed member gets 403, not 401, and takes the quarantine path instead.
- github.com only in this iteration. `/health` reports `githubHost: "github.com"`; the client refuses a hub whose `githubHost` differs from the profile's `MERGEPORT_HOST`. GitHub Enterprise support would add a hub-side API base setting later; nothing in this design prevents it.

**Space deletion and loss of access.** Deleting a restricted space (`DELETE /admin/spaces/:id`) is a deliberate, confirmed act on the authority. The hub emits `{ "t": "access", "spaceId", "action": "deleted" }` to every member of that space and `"removed"` to a member taken out of it. Both are handled by the client the same way: the engine's `revokeSpace` path **purges** the cached rows that came from that space on every client, the deleting admin's included, and quarantines unsent ops. The GitHub-mode exception where an admin keeps a vanished repository's data locally exists because a GitHub repository can disappear by accident; a hub deletion cannot, so it is not carried over. The confirmation dialog says that the space's projects, cards and tasks will be removed from every member's computer.

#### HTTP API (JSON)

```
GET  /health                                   -> { ok, team: { name } | null, schema, publicUrl, githubHost }      (no auth; team is null before the owner signs in)
POST /auth/device/start                        -> { deviceCode, userCode, verificationUri, interval, expiresIn }   (no auth; proxies GitHub's device flow with scope read:user)
POST /auth/device/poll   { deviceCode }        -> 202 pending | 200 { session, member, team } | 403 { reason: "not-invited" | "removed" } | 410 expired
POST /auth/logout
GET  /me                                       -> { member, team, members: [{ githubId, login, name, avatarUrl, role, status }], spaces: [{ id, kind, name, canWrite, seq }] }
GET  /spaces/:id/entities?since=<seq>          -> { seq, events: [...] }  | 410 when `since` is older than the retained log
GET  /spaces/:id/snapshot                      -> { seq, entities: [...] }  (full resync)
POST /spaces/:id/ops     { ops: [{ opId, type, entityId, kind: UPSERT|DELETE, baseVersion, data }] }
                                               -> { results: [{ opId, status: "applied"|"duplicate"|"stale", version, current? }], seq }
Admin:
GET  /admin/members, POST /admin/invites, DELETE /admin/members/:githubId, PATCH /admin/members/:githubId { role }
GET  /admin/spaces, POST /admin/spaces { name, members: [...] }, PATCH /admin/spaces/:id { name?, members? }, DELETE /admin/spaces/:id
```

Op semantics, per op, inside one SQLite transaction per request:

- `duplicate`: the `opId` is already in the entity's `appliedOps` (or the event log). Nothing changes; the current version is returned.
- `stale`: `baseVersion` differs from the entity's current version (0 for a new entity). Nothing changes; `current` carries the whole current entity so the client can three-way merge locally and retry. This is the hub-mode equivalent of `HeadMovedError`, but per entity rather than per push, so one teammate's edit on card A never blocks another's edit on card B.
- `applied`: version incremented, `seq` incremented, an `EntityEvent` written, a notification queued.

Notifications are sent after the transaction commits.

#### WebSocket

`GET /ws` with the bearer token in the `Sec-WebSocket-Protocol` header (`mergeport.v1, bearer.<token>`), never in the URL. Server messages:

```
{ "t": "hello", "spaces": [{ "id", "seq" }] }
{ "t": "changed", "spaceId", "seq" }                 -- fetch /spaces/:id/entities?since=<your cursor>
{ "t": "access", "spaceId", "action": "added"|"removed"|"deleted" }
{ "t": "team", "reason": "member"|"role" }
{ "t": "bye", "reason": "removed"|"shutdown" }
```

The hub coalesces notifications per space per 100 ms, so a burst of ops is one message. Clients send `{ "t": "ping" }` every 25 s; the hub drops a socket silent for 75 s.

#### Operations

- `npm run hub` starts it. A `hub/README.md` documents the OAuth App registration (Homepage URL = public URL; device flow enabled; no callback needed), the Caddyfile (two lines), a systemd unit, backup (`sqlite3 hub.db ".backup …"`), and upgrade (stop, `npm ci`, migrations run at start, start).
- Hub migrations run at start and refuse a database from a newer hub, mirroring `src/lib/db/migrate.ts`.
- Rate limiting: 60 requests per 10 s per session, 10 device-flow starts per minute per IP. 429 with `Retry-After`.
- Logs never contain tokens, entity data, or user codes.

### The client

#### Transport abstraction

`src/lib/sync/store.ts` currently exports a concrete `CoordinationStore` that speaks GitHub's git-data API; `SyncEngine` calls `head`, `tree`, `blob`, `commit`, `info`. The engine is organized around a repository (head SHA, tree, blobs). Rather than forcing the hub into that shape, the engine gains a second, narrower backend interface, and both backends implement the parts the engine needs:

```ts
type Backend =
  | { kind: "github"; store: CoordinationStore }          // existing, untouched
  | { kind: "hub"; client: HubClient };

interface HubClient {
  me(): Promise<Me>;
  pull(spaceId: string, since: bigint): Promise<{ seq: bigint; events: EntityEvent[] } | "gone">;
  snapshot(spaceId: string): Promise<{ seq: bigint; entities: EntityFile[] }>;
  push(spaceId: string, ops: Op[]): Promise<{ results: OpResult[]; seq: bigint }>;
}
```

`SyncEngine.pullSpace` and `pushSpace` branch on `backend.kind` at the top. The shared parts (`capture`, `reconcile`, `openConflict`, `resolveConflict`, tombstones, quarantine, schema-skew blocking, `stateFor`) stay single and are reused as is. The GitHub branch is the current code moved into a method, with no behavioural change; its tests must pass unchanged.

Hub pull: `pull(space, space.hubCursor)`; for each event call the existing `reconcile(ctx, def, fileFromEvent, sha = String(seq), local)`; store the new cursor on `Space.hubCursor`. On `"gone"`: snapshot, reconcile every entity, mark entities absent from the snapshot as deleted, set the cursor.

Hub push: gather PENDING ops as today, send them in one request, then per result: `applied` or `duplicate` → mark SENT and update `SyncEntity` base; `stale` → run the three-way merge against `current` (base from `SyncEntity`, local from the op); if clean, rewrite the op with the merged data and `baseVersion = current.version` and retry in the same cycle (at most 3 rounds); if conflicting, open a `SyncConflict` exactly as the GitHub path does.

#### Live updates

A `HubLink` (`src/lib/hub/link.ts`) keeps one WebSocket per active hub profile, reconnecting with backoff 1 s → 30 s with jitter. `changed` triggers `engine.syncSpace(space)` immediately (debounced 100 ms per space). `access` and `team` trigger `me()` and a space list refresh. While the socket is down the engine polls every 60 s, so a missed notification costs at most a minute; `expectedConsistencyDelaySeconds` reports "about 1 s (live)" in hub mode and the existing numbers in GitHub mode.

`Space` gains `backend` (`GITHUB|HUB`), `hubSpaceId`, `hubCursor`; for hub spaces `repoOwner`/`repoName` are empty strings and the unique index moves to `(backend, repoOwner, repoName, hubSpaceId)`. `TeamConfig` gains `backend` and `hubOrigin`.

#### Sign-in and first run

The sign-in page (`src/app/sign-in/page.tsx`) gets two cards:

1. **Use GitHub only** — the existing flow, word for word.
2. **Connect to a server** — a text field for the server URL. On submit the app calls `GET <url>/health`, shows the team name and the public URL the hub reports (refuses if it differs from what was typed, to stop a typo landing on a stranger's hub), then starts the device flow and shows the user code with a "Open GitHub" button. On success the profile for `(host, id, hub-<fp>)` is created or opened, the hub is saved to `hubs.json`, `active.json` is written, and the app switches to it.

The `gh` sign-in is still required in hub mode for GitHub data. Order: the device flow signs the person into the hub as GitHub user X; the app then requires `gh` to be signed in as the same numeric id X before opening the profile, with the same mismatch banner that exists today. A hub profile is never opened as a different GitHub account than the one that signed into the hub.

#### Team page in hub mode

The Team page shows the hub's team name and origin, the members with roles, invite by username (ADMIN+), remove and change role (ADMIN+), restricted spaces with their members (ADMIN+), "Sign out of this server", and the connection state (Live / Reconnecting / Offline, with pending op count). The GitHub-mode Team page is unchanged and is what renders in GitHub mode.

The existing `TeamService` stays GitHub-only. A new `HubTeamService` covers the hub operations; the page picks one by `TeamConfig.backend`.

#### Privacy in hub mode

The hub decides what a client receives; the client never filters. The existing guard that keeps restricted-space entities out of the common space (`tests/review-fixes.test.ts`, cross-space tombstones and file takeover) applies unchanged because the engine still keys everything by `spaceId`. A client is told about a restricted space only by `/me`, after the hub checked `SpaceMember`.

## Decisions already made (by the person)

- The VPS is a shared hub only; Mergeport stays local and each person keeps their own `gh`.
- Shared data is stored on the hub, not in GitHub repositories, when a hub is used.
- Live sync: changes are pushed, not polled.
- The GitHub-repository mode is kept, unchanged, and remains available.
- First run offers connecting to a server as an alternative to GitHub-only; switching between servers and GitHub happens inside the app.
- Identity on the hub: GitHub OAuth (device flow), not hub-local accounts.
- Edits made while the hub is unreachable queue and are sent on reconnect.

## Decisions made by this document (the person may override)

- One SQLite profile per backend; switching changes profile and re-fetches GitHub data. (Alternative rejected: a `backendId` column on every shared table, a large schema change with mixing risk.)
- Hub database is SQLite in WAL mode, not Postgres. Postgres is a later swap behind Prisma if a team outgrows it.
- One hub = one team. The first person to sign in to an empty hub becomes OWNER and names the team.
- Per-entity optimistic concurrency (`baseVersion`) on the hub, with local three-way merge on `stale`, instead of CRDTs. This reuses `merge.ts` and the conflict UI as is.
- Hub session token stored encrypted in the profile SQLite with a per-profile key file, not in the OS keychain (no new native dependency).
- WebSocket for notifications only; data always travels over HTTP by cursor. (Simpler recovery; a missed message is harmless.)
- Plain `http://` hub URLs are refused except loopback.
- Scope `read:user` only for the hub's OAuth App.
- Switching is a supervised child restart, not an in-process database swap.
- Hub sessions slide for 30 days; expiry means signing in again, with queued edits kept.
- Deleting a hub space purges it from every member's computer, the deleting admin's included.
- Every member sees the member list and roles.
- github.com only; `/health` names the GitHub host and the client refuses a mismatch.

## Left to the builder

- Exact file layout under `hub/`, choice between `ws` and `undici`'s WebSocket, and how the hub's Prisma client is generated next to the app's (`hub/src/generated`), keeping `npm run build` of the app unaffected.
- The UI for the switcher and the second sign-in card, within `DESIGN.md`.
- Debounce and backoff constants beyond those stated.
- Whether `migrate:from-postgres` needs to know about hub profiles (it should not: it imports into a `github` profile).

## Verification required before this is done

- All existing tests pass unchanged, including `tests/team-sync.test.ts` and `tests/review-fixes.test.ts`.
- New `tests/hub-sync.test.ts`: two isolated clients against a real in-process hub (no mocks of the hub): live propagation under 1 s, concurrent edits to different entities (no conflict), same-field edits (one `stale`, merged or conflict), duplicate op retry (one application), offline queue and reconnect, delete tombstone, removed member (socket closed with 4403, quarantine, purge), restricted space invisible to a non-member (by request, not by UI), cursor expiry (`410` → snapshot), hub restart with clients connected, newer hub schema refused by an older client.
- New `tests/hub-auth.test.ts`: device flow against a fake GitHub, invite by login resolving to numeric id, not-invited refusal, owner bootstrap, role enforcement on every admin route, token never logged.
- New `tests/profile-switch.test.ts`: the supervisor restarts the child on the other profile, the browser lands signed in on the new launch link, data is isolated, and hub entities are never written to a GitHub space or the reverse.
- Manual, recorded in `docs/architecture.md`: a hub behind Caddy with real TLS, two real GitHub accounts, invite, join, edit, remove.
