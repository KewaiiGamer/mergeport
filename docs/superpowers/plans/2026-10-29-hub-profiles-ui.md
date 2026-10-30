# Hub Profiles, Switching and Hub UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Profiles keyed by `(host, id, backend)`, a supervising launcher that switches workspace by restarting the Next child, a "Workspace" switcher, a "Connect to a server" sign-in card, and a hub-mode Team page.

**Architecture:** Pure path/registry helpers (`backends.ts`, `registry.ts`) feed a `Supervisor` that owns the Next child and a loopback control server. The app asks the supervisor to switch (after writing `active.json`); the browser shows "Switching workspace…", polls `/api/local/ready` until the boot id changes, then follows the new launch link. The hub bits (device flow, admin calls, session storage, link status) sit behind interfaces in `src/lib/hub/ports.ts` because plans 1 and 2 (branches `hub-service`, `hub-client`) are not on this branch; a fake hub server in `tests/fake-hub.ts` implements the spec's HTTP API subset. Integration = replace `src/lib/hub/ports-stub.ts` with plan 2's `HubClient`/`HubSession`/`HubLink`.

**Tech Stack:** Node 24, TypeScript, Next.js 16 (read `node_modules/next/dist/docs/` before touching routes/server actions; AGENTS.md says APIs differ), Prisma 7 + SQLite, vitest (`tests/**/*.test.ts`, `fileParallelism: false`).

**Spec:** `docs/superpowers/specs/2026-10-29-hub-server-design.md` (sections "Profiles and switching", "Hub session token storage", "Sign-in and first run", "Team page in hub mode", "Authorization on the hub", "HTTP API", "Verification required" for `tests/profile-switch.test.ts`). Executors read it.

## Global Constraints

- Profile key `(host, GitHub user id, backend)`; backend is `github` (path `~/.mergeport/profiles/<host>-<id>/mergeport.db` UNCHANGED, nothing migrates) or `hub-<fingerprint>`, fingerprint = first 16 hex chars of SHA-256 of the normalized hub origin.
- `~/.mergeport/active.json` = `{ "host", "accountId", "backend" }`; `~/.mergeport/hubs.json` = list of `{ origin, teamName, lastSignedInAs: { id, login }, addedAt }`. No tokens in either, in logs, in the browser, or in any URL.
- Client refuses `http://` hub URLs except loopback (`127.0.0.1`, `localhost`, `[::1]`).
- `GET <url>/health` → `{ ok, team: { name } | null, schema, publicUrl, githubHost }`; refuse when `publicUrl` differs from what was typed, or `githubHost` differs from `MERGEPORT_HOST`.
- Device flow: `POST /auth/device/start` → `{ deviceCode, userCode, verificationUri, interval, expiresIn }`; `POST /auth/device/poll { deviceCode }` → `202` pending | `200 { session, member, team }` | `403 { reason: "not-invited" | "removed" }` | `410` expired. Never log user codes or session tokens.
- `gh` must be signed in as the same numeric id that signed into the hub, else the existing mismatch banner (`AccountMismatchError`, `?error=mismatch`). A hub profile is never opened as another account.
- Switching must not require re-running `npm run local`; child restart, never an in-process DB swap. Page text "Switching workspace…".
- GitHub sign-in card/flow word for word unchanged; GitHub-mode Team page unchanged; `TeamService` stays GitHub-only; hub mode adds `HubTeamService`, page picks by `TeamConfig.backend`.
- Hub entities never written to a GitHub space or the reverse; every existing test passes unchanged.
- Visual rules from `DESIGN.md` (existing `panel`, `btn`, `Banner`, `pill`, Lucide icons only, tokens not raw colours, hit areas ≥40px).
- Verification before done: `npm run typecheck`, `npm run lint`, `npm test`.
- Do not edit `prisma/schema.prisma` (plan 2 owns `TeamConfig.backend/hubOrigin`, `Space.backend`, `HubSession`).

## Review Focus

- Dirs `github.com-123-hub-<fp>` sit beside `github.com-123`; `savedProfiles`' prefix scan must not return hub dirs as GitHub profiles (Task 1 test).
- Hub URL typed with trailing slash, path, uppercase host, default port, or userinfo (`https://user:pw@host`) must normalize to one origin / be refused, so fingerprints agree (Task 1, Task 5).
- Switch requested while a previous switch or child crash is in flight: one child at a time, second request coalesced or rejected, never two children on one port (Task 2).
- Child dies unexpectedly / new child fails to boot: supervisor must report failure and keep the old `active.json` target restorable instead of leaving a dead launcher (Task 2, Task 3).
- `active.json` / `hubs.json` corrupt, half-written or missing: fall back to the `github` profile, never crash the launcher (Task 1).

---

## File Structure

- Create `src/lib/local/backends.ts` — `GITHUB_BACKEND`, `normalizeHubOrigin`, `hubBackendId`, `isHubBackend`.
- Modify `src/lib/local/profile.ts` — `profileDirName`/`profileDbPath` take optional backend.
- Modify `src/lib/local/saved-profiles.ts` — ignore hub dirs.
- Create `src/lib/local/registry.ts` — read/write `active.json`, `hubs.json`.
- Create `src/lib/local/supervisor.ts` — `Supervisor`, control server, `ControlClient`.
- Modify `scripts/start-local.ts` — use supervisor, honor `active.json`.
- Create `src/app/api/local/ready/route.ts`, `src/app/api/local/switch/route.ts`, `src/app/switching/page.tsx` (+ client component).
- Create `src/lib/local/backend-guard.ts` — hub/GitHub isolation assertion.
- Create `src/lib/hub/ports.ts`, `src/lib/hub/ports-stub.ts` — interfaces + stand-ins.
- Create `src/lib/hub/connect.ts` — `HubAuth` HTTP client + `connectFlow` orchestration.
- Create `src/app/api/local/hub/{check,start,poll}/route.ts`, `src/components/forms/HubConnect.tsx`; modify `src/app/sign-in/page.tsx`.
- Create `src/components/shell/WorkspaceSwitcher.tsx`; modify `src/components/shell/Topbar.tsx`, `src/app/(app)/layout.tsx`.
- Create `src/lib/team/hub-service.ts` (`HubTeamService`), `src/components/team/HubTeamPanel.tsx`; modify `src/app/(app)/team/page.tsx` (branch only), new `src/app/hub-team-actions.ts`.
- Tests: `tests/profiles-registry.test.ts`, `tests/supervisor.test.ts`, `tests/profile-switch.test.ts`, `tests/hub-connect.test.ts`, `tests/hub-team-service.test.ts`, helpers `tests/fake-hub.ts`, `tests/fixtures/fake-child.mjs`.
- Modify `docs/architecture.md` (manual-verification note).

---

### Task 1: Backend ids, profile paths, registry files

**Files:** Create `src/lib/local/backends.ts`, `src/lib/local/registry.ts`; Modify `profile.ts`, `saved-profiles.ts`; Test `tests/profiles-registry.test.ts`.

**Interfaces:**
- Produces:
  - `type Backend = "github" | \`hub-${string}\``; `GITHUB_BACKEND = "github"`.
  - `normalizeHubOrigin(input: string): string` — lowercases scheme+host, drops path/query/hash/trailing slash/default port; throws `ValidationError` (from `@/lib/errors`) for non-URL, userinfo, or `http:` on non-loopback.
  - `hubBackendId(origin: string): Backend` → `"hub-" + sha256(normalizeHubOrigin(origin)).hex.slice(0,16)`; `isHubBackend(b: string): b is \`hub-${string}\``.
  - `profileDirName(host, accountId, backend: Backend = "github")` → unchanged string for github, else `${old}-${backend}`; `profileDbPath(home, host, accountId, backend = "github")`.
  - registry: `type Active = { host: string; accountId: string; backend: Backend }`; `readActive(home): Active | null`, `writeActive(home, a: Active): void`; `type HubEntry = { origin: string; teamName: string; lastSignedInAs: { id: string; login: string }; addedAt: string }`; `readHubs(home): HubEntry[]`, `upsertHub(home, e: HubEntry): void`, `removeHub(home, origin): void`. Writes are atomic (temp file + rename), reads tolerate missing/corrupt files (return `null`/`[]`). Account ids are strings (bigint-safe).

- [ ] **Step 1: Write failing tests** in `tests/profiles-registry.test.ts` (temp `home` like `tests/saved-profiles.test.ts`):
  - `normalizeHubOrigin("HTTPS://Hub.Example.com:443/x/?a#b")` equals `"https://hub.example.com"`; `"http://localhost:8787/"` equals `"http://localhost:8787"`; `"http://hub.example.com"`, `"https://u:p@hub.example.com"`, `"nope"` each throw.
  - `hubBackendId("https://hub.example.com/")` equals `hubBackendId("https://HUB.example.com")`, matches `/^hub-[0-9a-f]{16}$/`.
  - `profileDbPath(h,"github.com",5n)` unchanged (ends `github.com-5/mergeport.db`); with a hub backend ends `github.com-5-hub-<16hex>/mergeport.db`.
  - `savedProfiles(h,"github.com")` with dirs `github.com-5` (valid db) and `github.com-5-hub-0123456789abcdef` (valid db) returns only the first.
  - `readActive` returns `null` for missing file, for `"{not json"`, and for wrong shape; `writeActive`→`readActive` round-trips; `upsertHub` twice with same origin keeps one entry; `readHubs` on corrupt file is `[]`; serialized `hubs.json` text contains no key named `token` or `session`.
- [ ] **Step 2:** Run `npx vitest run tests/profiles-registry.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement the signatures above. `savedProfiles` keeps its prefix scan but additionally requires dir name to match `^<escaped host>-\d+$`.
- [ ] **Step 4:** Run the new test plus `npx vitest run tests/saved-profiles.test.ts tests/identity-binding.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `feat: profile backends and active/hubs registry`.

---

### Task 2: Supervisor and control channel

**Files:** Create `src/lib/local/supervisor.ts`, `tests/fixtures/fake-child.mjs`; Test `tests/supervisor.test.ts`.

**Interfaces:**
- Consumes: `killTree` (`@/lib/github/exec`), Task 1 registry types.
- Produces:
  ```ts
  type ChildSpec = { dbFile: string; token: string; port: number; demo: boolean };
  type SupervisorDeps = {
    spawnChild(spec: ChildSpec): ChildHandle;           // ChildHandle = { kill(): Promise<void>; onExit(cb: (code: number|null) => void): void }
    waitReady(port: number, signal: AbortSignal): Promise<string>;  // resolves the child's boot id
    resolveTarget(req: { backend: Backend }): Promise<{ dbFile: string }>;  // throws if not available
    newToken(): string;
  };
  class Supervisor {
    constructor(deps: SupervisorDeps, opts: { port: number; demo: boolean });
    start(initial: { dbFile: string }): Promise<{ launchUrl: string; bootId: string }>;
    switchTo(req: { backend: Backend }): Promise<{ launchUrl: string; bootId: string }>;  // serialized; concurrent callers share the in-flight promise
    stop(): Promise<void>;
    listenControl(): Promise<{ url: string; secret: string }>;      // 127.0.0.1, random port, random secret
  }
  class ControlClient { constructor(url: string, secret: string); switchTo(backend: Backend): Promise<{ launchUrl: string }> }
  ```
  Control protocol: `POST <url>/switch` with header `x-mergeport-control: <the child's MERGEPORT_LAUNCH_TOKEN>` and JSON `{ backend }`; 403 unless it is the current child's token, 400 on bad body, 409 `{error}` when target unavailable, 200 `{ launchUrl }`. The supervisor replies 200 only after the new child is ready. Child env gets `MERGEPORT_CONTROL_URL` (assembled by Task 3); the launch token it already has is the credential.
  Failure rule: if the new child fails to become ready, the supervisor respawns the previous `ChildSpec` and `switchTo` rejects with `Error("Could not start the other workspace; the previous one was restored")`.

- [ ] **Step 1: Write failing tests** with in-memory fake deps (no processes): (a) `switchTo` kills child A before spawning B, B gets a different token and the resolved dbFile, `launchUrl` = `http://127.0.0.1:<port>/api/local/launch?token=<B token>`; (b) two concurrent `switchTo` calls produce exactly one extra spawn and the same result; (c) never more than one live child (counter assertion across a sequence of 3 switches); (d) failing `waitReady` for B → A respawned, rejection message above, `spawn` count 3; (e) control server: wrong secret → 401, no secret → 401, `{backend:"nope"}` → 400, unknown target (`resolveTarget` throws) → 409, good request → 200 `launchUrl`; (f) child exits unexpectedly outside a switch → `Supervisor` emits `"child-exit"` (extend with `on(event, cb)`), and does not respawn.
- [ ] **Step 2:** `npx vitest run tests/supervisor.test.ts` → FAIL.
- [ ] **Step 3:** Implement with `node:http`; backend validated with `^(github|hub-[0-9a-f]{16})$`. Serialization with a single `inflight` promise chain.
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Create `tests/fixtures/fake-child.mjs`: a node http server on `MERGEPORT_PORT` binding 127.0.0.1 with `GET /api/local/ready` → `{ bootId }` (random at start), `GET /api/local/launch?token=` → one-time token check against `MERGEPORT_LAUNCH_TOKEN`, 403 when reused/wrong, else sets `Set-Cookie: sid=<hash of MERGEPORT_DB>` and redirects `/`; `GET /whoami` with that cookie → `{ db: MERGEPORT_DB }`. (Used by Task 4.)
- [ ] **Step 6:** Commit `feat: workspace supervisor with loopback control channel`.

---

### Task 3: Launcher uses the supervisor; ready and switch routes

**Files:** Modify `scripts/start-local.ts`, `src/lib/local/session-routes.ts`; Create `src/app/api/local/ready/route.ts`, `src/app/api/local/switch/route.ts`, `src/lib/local/switch-client.ts`; Test `tests/local-switch-route.test.ts`.

**Interfaces:**
- Consumes: Task 1 (`readActive`, `profileDbPath`, `hubBackendId`), Task 2 (`Supervisor`, `ControlClient`).
- Produces:
  - `src/lib/local/switch-client.ts`: `requestSwitch(backend: Backend, deps?: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch }): Promise<{ launchUrl: string }>`; uses `MERGEPORT_CONTROL_URL/SECRET`; throws `ValidationError("Switching needs the launcher. Start Mergeport with npm run local.")` when unset.
  - `GET /api/local/ready` → `{ bootId }` (module-level random id per process; no auth, no data).
  - `POST /api/local/switch` body `{ backend }`: `sameOrigin` check, requires a valid app session (same guard other POST routes use; check `src/proxy.ts` and `src/lib/auth/current.ts`), writes `active.json` for the viewer's `(host, accountId)` BEFORE calling `requestSwitch`, returns `{ launchUrl, bootId: previous }`. On error restores the previous `active.json` and returns 409 `{ error }`.
  - `startLocalSession()` gains profile awareness: when `readActive`'s backend is a hub, the `gh` identity id must equal the profile user's `githubId`, else `{ ok:false, error:"mismatch" }` (existing `ensureLocalProfile` already throws `AccountMismatchError` for a different id; add a test proving it for a hub db).

- [ ] **Step 1: Write failing tests**: `requestSwitch` throws the exact message when env unset; with a fake `fetch` returns `launchUrl` and sends header `x-mergeport-control`; route handler (call `POST` exported function with `Request`) rejects cross-origin with 403 and bad `backend` with 400; `active.json` is restored when `requestSwitch` rejects (mock via module mock of `switch-client`); `/ready` returns the same `bootId` across calls.
- [ ] **Step 2:** `npx vitest run tests/local-switch-route.test.ts` → FAIL.
- [ ] **Step 3:** Implement routes/client. In `start-local.ts`: after resolving the signed-in identity, choose `dbFile` = `profileDbPath(home, host, id, active?.backend)` when `readActive(home)` matches `(host, id)` AND that db file exists (else github path, and rewrite `active.json` to github); construct `Supervisor` with real deps (`spawnChild` = the existing `next start` spawn plus control env; `waitReady` polls `/api/local/ready` every 200 ms up to 60 s; `resolveTarget` maps `backend` → `profileDbPath` for the current signed-in id, throws if a hub profile db does not exist); `listenControl()` before first spawn; keep the existing SIGINT/SIGTERM → stop, the 2.5 s browser open, `--demo` and offline-saved-profile behaviour byte-compatible. Child `exit` while no switch is running ends the launcher as today.
- [ ] **Step 4:** Run the test and `npx vitest run tests/local-guard.test.ts tests/identity-binding.test.ts` → PASS. Run `npm run typecheck`.
- [ ] **Step 5:** Commit `feat: launcher supervises the app and exposes workspace switching`.

---

### Task 4: Switching page, isolation guard, and `tests/profile-switch.test.ts`

**Files:** Create `src/app/switching/page.tsx`, `src/components/shell/SwitchingClient.tsx`, `src/lib/local/backend-guard.ts`; Test `tests/profile-switch.test.ts`.

**Interfaces:**
- Produces:
  - `assertBackendMatch(config: { backend: Backend }, space: { backend: "GITHUB" | "HUB" }): void` — throws `ValidationError` unless (`github` ↔ `GITHUB`) or (`hub-*` ↔ `HUB`). Engine integration is a one-line call added when plan 2 merges (note in the file's header comment).
  - `/switching?from=<bootId>&to=<launchUrl-encoded>` page: client component shows "Switching workspace…", polls `/api/local/ready` each 400 ms, and when the `bootId` differs from `from` sets `window.location` to `to`; after 60 s shows a `Banner` "The other workspace did not start" with a link to `/`. The `to` value must be validated server-side to be `http://127.0.0.1:<port>/api/local/launch?token=…` on the request's own host; anything else renders the error state (open-redirect guard).

- [ ] **Step 1: Write `tests/profile-switch.test.ts`** (real processes via `Supervisor` + `fake-child.mjs`; temp home; two db files made with `createPrisma` for github and hub profiles of the same account; seed one `Project`-like row distinct in each using `db.workspace.create`):
  - supervisor started on the github profile; `GET /whoami` (after following `launchUrl`, cookie jar by hand) shows the github db path;
  - `ControlClient.switchTo(hubBackend)`: old child's port stops answering then a new child answers `/ready` with a different `bootId`; following the returned `launchUrl` lands signed in (cookie accepted, `/whoami` shows the hub db path); reusing the same `launchUrl` returns 403;
  - the old launch link of the first child no longer works after the switch;
  - data isolation: reading the workspace names through `createPrisma` on each file shows only its own row after the switch back and forth twice;
  - `assertBackendMatch({backend: hubId}, {backend:"GITHUB"})` throws and `({backend:"github"}, {backend:"HUB"})` throws, matching pairs do not; a `/switching` target URL pointing to another host is rejected by the page's validator (export `validateSwitchTarget(url: string, host: string): boolean` and assert it).
  - Always `supervisor.stop()` in `afterEach`; test timeout 30 s.
- [ ] **Step 2:** `npx vitest run tests/profile-switch.test.ts` → FAIL.
- [ ] **Step 3:** Implement page, client, guard, validator. Page uses existing `Logo` and `panel` classes.
- [ ] **Step 4:** Run the test → PASS; `npm run lint`.
- [ ] **Step 5:** Commit `feat: switching page, backend isolation guard, profile-switch test`.

---

### Task 5: Hub auth client and fake hub

**Files:** Create `src/lib/hub/ports.ts`, `src/lib/hub/ports-stub.ts`, `src/lib/hub/connect.ts`, `tests/fake-hub.ts`; Test `tests/hub-connect.test.ts`.

**Interfaces:**
- Consumes: Task 1 (`normalizeHubOrigin`, `hubBackendId`, `upsertHub`, `writeActive`, `profileDbPath`), `ensureLocalProfile`, `currentGhStatus`.
- Produces in `ports.ts` (the seam plan 2 fills; names follow the spec):
  ```ts
  type HubSessionPort = {
    // stores the token encrypted in the profile db (plan 2: HubSession table + key file)
    save(dbFile: string, s: { origin: string; token: string; githubId: string }): Promise<void>;
    // marks TeamConfig.backend = hubId, hubOrigin = origin (plan 2 columns)
    markProfile(dbFile: string, p: { backend: Backend; origin: string; teamName: string }): Promise<void>;
  };
  type HubLinkStatus = { state: "live" | "reconnecting" | "offline"; pendingOps: number; needsSignIn: boolean };
  type HubAdminApi = { /* defined in Task 8 */ };
  ```
  `ports-stub.ts` exports `hubSessionPort` (writes a `hub-session.json` and `hub-profile.json` next to the db, clearly commented as a stand-in) and `hubLinkStatus(dbFile)` returning `{state:"offline", pendingOps:0, needsSignIn:false}`.
  `connect.ts`:
  - `class HubAuth { constructor(fetchImpl = fetch); health(typed: string, expectHost: string): Promise<{ origin: string; teamName: string | null; backend: Backend }>; start(origin): Promise<{ deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number }>; poll(origin, deviceCode): Promise<{ status: "pending" } | { status: "ok"; session: string; member: { githubId: string; login: string }; team: { name: string } } | { status: "refused"; reason: "not-invited" | "removed" } | { status: "expired" }> }`. `health` rejects (`ValidationError`, messages naming the cause) when: unreachable, `ok` false, `publicUrl` normalized ≠ typed origin ("This server says it lives at X, not Y"), `githubHost` ≠ `expectHost`.
  - `completeConnect(i: { home; host; origin; teamName; session; member; gh: GhStatus; ports }): Promise<{ ok: true; backend: Backend } | { ok: false; error: "mismatch" | "gh-login" | "gh-missing" | "gh-error" }>` — requires `gh.state==="ok" && gh.identity.id === BigInt(member.githubId)` BEFORE creating anything (mismatch → no profile, no hubs.json, no active.json written); then `createPrisma(dbFile)` + `ensureLocalProfile` + `hubSessionPort.save` + `markProfile`, `upsertHub`, `writeActive`.
- Fake hub `tests/fake-hub.ts`: `startFakeHub(opts: { publicUrl?: string; githubHost?: string; team?: string|null; invited?: boolean; removed?: boolean; pollsBeforeOk?: number; githubId?: string; login?: string })` → `{ origin, stop(), requests: {method,path,body}[] }` on loopback, implementing only `/health`, `/auth/device/start`, `/auth/device/poll` per the Global Constraints; records requests so tests can assert no token or user code reached any log line (the fake never logs).

- [ ] **Step 1: Write failing tests** in `tests/hub-connect.test.ts`: health OK returns team name and canonical origin for `"HTTP://127.0.0.1:<p>/"`; `publicUrl` mismatch rejected with message containing both origins; `githubHost: "ghe.example.com"` rejected when expecting `github.com`; `ok:false` and a closed port rejected; plain `http://example.com` rejected before any request (`requests.length === 0`); `start` returns the user code; `poll` yields pending twice then ok (`pollsBeforeOk: 2`); `invited:false` → `refused/not-invited`; `removed` → `refused/removed`; expiry → `expired`; `completeConnect` with matching gh id creates `profiles/github.com-<id>-hub-<fp>/mergeport.db`, `hubs.json` entry with `lastSignedInAs`, `active.json` with the hub backend, and `hubs.json` text does not contain the session token; with a different gh id returns `mismatch` and the home directory stays empty; gh `not-logged-in` → `gh-login`.
- [ ] **Step 2:** `npx vitest run tests/hub-connect.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Use `AbortSignal.timeout(8000)` on every fetch. Never include the session or user code in thrown error messages.
- [ ] **Step 4:** Run test → PASS.
- [ ] **Step 5:** Commit `feat: hub health check, device flow client and profile creation`.

---

### Task 6: "Connect to a server" sign-in card

**Files:** Create `src/app/api/local/hub/check/route.ts`, `.../start/route.ts`, `.../poll/route.ts`, `src/components/forms/HubConnect.tsx`; Modify `src/app/sign-in/page.tsx`; Test `tests/hub-connect-routes.test.ts`.

**Interfaces:**
- Consumes: Task 5 (`HubAuth`, `completeConnect`), Task 3 (`requestSwitch`).
- Produces: JSON POST routes (all `sameOrigin`-checked; origin always re-derived through `normalizeHubOrigin`, never trusted from a previous step):
  - `check` `{ url }` → `{ ok:true, teamName, origin }` | `{ ok:false, error }`;
  - `start` `{ url }` → `{ ok:true, userCode, verificationUri, interval, deviceCode }`;
  - `poll` `{ url, deviceCode }` → `{ status:"pending" }` | `{ status:"ok", switchTo: { launchUrl, from } }` | `{ status:"refused", reason }` | `{ status:"expired" }` | `{ status:"error", error: "mismatch"|"gh-login"|... }`. On `ok` the route runs `completeConnect` then `requestSwitch` and returns the link; the hub session token never appears in any response.
  - Sign-in page: the existing card is untouched; a second `panel` titled "Connect to a server" is added below it (hidden in demo mode). `HubConnect` steps: URL field + "Check server" → shows team name and reported URL → "Connect" → shows the user code in `mono`, an "Open GitHub" link (`verificationUri`, `target="_blank" rel="noopener noreferrer"`), polls at `interval` → on `ok` navigates to `/switching?from=…&to=…`. Errors via `Banner`; extend the page's `ERRORS` map only by adding keys (`hub-not-invited`, `hub-removed`, `hub-expired`) so existing keys keep their text.

- [ ] **Step 1: Write failing tests** (call route handlers directly against `startFakeHub`, temp `MERGEPORT_HOME`, `vi.mock` of `@/lib/local/identity` `currentGhStatus` and `@/lib/local/switch-client`): cross-origin POST → 403; `check` with mismatched `publicUrl` → `ok:false`; full `start`→`poll`(pending)→`poll`(ok) writes `active.json` and calls `requestSwitch` once with the hub backend; poll `ok` with gh as another id → `error:"mismatch"` and no files; responses never contain the session string; not-invited → `status:"refused"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement routes, component, page edit. Check `node_modules/next/dist/docs/` for route-handler conventions first. **Step 4:** Run the test, `tests/local-guard.test.ts`, `npm run typecheck`, `npm run lint` → PASS.
- [ ] **Step 5:** Visual check in the Browser pane at 1024 and 390 px against `DESIGN.md`, then commit `feat: connect to a server card on sign-in`.

---

### Task 7: Workspace switcher

**Files:** Create `src/components/shell/WorkspaceSwitcher.tsx`, `src/lib/local/workspaces.ts`; Modify `src/components/shell/Topbar.tsx`, `src/app/(app)/layout.tsx`; Test `tests/workspaces.test.ts`.

**Interfaces:**
- Consumes: Task 1 registry, Task 3 `/api/local/switch`.
- Produces: `listWorkspaces(home: string, host: string, accountId: string): { active: Backend; entries: { backend: Backend; label: string; detail?: string; available: boolean }[] }` — first entry `github` labelled "GitHub (repositories)"; one entry per `hubs.json` item labelled by `teamName` with `detail` = origin; the active one is from `readActive` (default `github`). A hub whose profile dir for this account does not exist is still listed (`available: true`; the sign-in card handles creation) — but `lastSignedInAs.id` differing from `accountId` is flagged `available: false`, `detail` "Signed in as @login". `WorkspaceSwitcher` props `{ entries, active }`: a Radix `Select`-style menu (reuse `@/components/ui/Select`) labelled "Workspace", active marked, plus an item "Connect to a server…" linking to `/sign-in?connect=1`; choosing an entry `fetch("/api/local/switch", POST)` then `location = /switching?...`. Hidden in demo mode and when `MERGEPORT_CONTROL_URL` is unset (then a static label "GitHub (repositories)").

- [ ] **Step 1: Write failing tests** for `listWorkspaces`: default with empty home → only GitHub, active `github`; two hubs listed in `addedAt` order; active marked from `active.json`; other-account hub `available:false`; corrupt `active.json` → `github`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; the layout computes entries server-side and passes them through `Topbar` (new optional prop `workspaces`). Existing Topbar callers keep working. **Step 4:** Tests + typecheck + lint → PASS; check in the Browser pane (desktop + 390 px). **Step 5:** Commit `feat: workspace switcher in the top bar`.

---

### Task 8: `HubTeamService`

**Files:** Create `src/lib/team/hub-service.ts`; Modify `src/lib/hub/ports.ts` (add `HubAdminApi`), `ports-stub.ts`; Test `tests/hub-team-service.test.ts`, extend `tests/fake-hub.ts` with `/me`, `/admin/*`.

**Interfaces:**
- Produces in `ports.ts`:
  ```ts
  type HubMember = { githubId: string; login: string; name: string | null; avatarUrl: string | null; role: "OWNER"|"ADMIN"|"MEMBER"|"READER"; status: "INVITED"|"ACTIVE"|"REMOVED" };
  type HubSpaceInfo = { id: string; kind: "COMMON"|"RESTRICTED"; name: string; canWrite: boolean; seq: string };
  type HubAdminApi = {
    me(): Promise<{ member: HubMember; team: { name: string }; members: HubMember[]; spaces: HubSpaceInfo[] }>;
    invite(login: string, role: "ADMIN"|"MEMBER"|"READER"): Promise<void>;
    removeMember(githubId: string): Promise<void>;
    setRole(githubId: string, role: "ADMIN"|"MEMBER"|"READER"): Promise<void>;
    createSpace(name: string, members: { githubId: string; canWrite: boolean }[]): Promise<HubSpaceInfo>;
    updateSpace(id: string, p: { name?: string; members?: { githubId: string; canWrite: boolean }[] }): Promise<void>;
    deleteSpace(id: string): Promise<void>;
    logout(): Promise<void>;
  };
  class HubUnauthorized extends Error {}   // 401
  class HubForbidden extends Error {}      // 403
  ```
  `ports-stub.ts` exports `httpHubAdmin(origin: string, token: () => Promise<string | null>, fetchImpl?)` implementing the spec routes (`GET /me`, `POST /admin/invites`, `DELETE /admin/members/:githubId`, `PATCH /admin/members/:githubId {role}`, `POST/PATCH/DELETE /admin/spaces…`, `POST /auth/logout`) with `Authorization: Bearer`; 401 → `HubUnauthorized`, 403 → `HubForbidden`, 429 → error carrying `Retry-After`.
- `HubTeamService`: `constructor(api: HubAdminApi, actorGithubId: string)`; `overview(): Promise<{ teamName; me: HubMember; members: HubMember[]; spaces: HubSpaceInfo[]; canAdmin: boolean }>` (`canAdmin` = role OWNER|ADMIN); every mutating method first checks `canAdmin` locally for a friendly `ValidationError("Only admins can …")` — UX only, the hub decides; `invite(login)` trims a leading `@`, lowercases, rejects empty/invalid GitHub login (`/^[a-z\d](?:[a-z\d-]{0,38})$/i`); `changeRole` refuses targeting the OWNER or yourself; `removeMember` refuses the OWNER; `deleteSpace(id, { confirmed })` requires `confirmed: true` and `ValidationError` text `"Deleting this space removes its projects, cards and tasks from every member's computer."` otherwise; `signOut(dbFile)` calls `api.logout()` (ignore network failure) then removes the stored hub session via the port and returns `{ switchTo: "github" }`.

- [ ] **Step 1: Write failing tests** against the extended fake hub (roles enforced by the fake like the spec: ADMIN+ for admin routes): overview lists members with roles; MEMBER cannot invite (local `ValidationError`, and zero requests reach the hub); ADMIN invites `@Octo-Cat` → hub receives `octo-cat`; invalid login rejected; OWNER cannot be removed or re-roled; `deleteSpace` without confirmation throws and sends nothing; 401 from hub surfaces as `HubUnauthorized`; 403 `HubForbidden`; `signOut` still succeeds when the hub is down.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5:** Commit `feat: HubTeamService over a hub admin port`.

---

### Task 9: Hub-mode Team page

**Files:** Create `src/components/team/HubTeamPanel.tsx`, `src/app/hub-team-actions.ts`; Modify `src/app/(app)/team/page.tsx`, `src/lib/local/runtime.ts` (add `getHubTeamService()`); Test `tests/hub-team-page.test.ts`.

**Interfaces:**
- Consumes: Task 8 `HubTeamService`, Task 5 `hubLinkStatus`, `TeamConfig.backend` (plan 2 column; until merged read it through `readActive(home).backend` — one helper `currentBackend(): Promise<Backend>` in `src/lib/local/workspaces.ts`, replaced by the column on integration).
- Produces: the page begins with `if (isHubBackend(await currentBackend())) return <HubTeamPage />` placed before any GitHub-specific code, so the GitHub render path stays byte-identical. `HubTeamPage` shows: header with team name and origin; connection pill (Live / Reconnecting / Offline) plus "N pending" from `hubLinkStatus`; members table with role and a role select + remove (admins only); invite-by-username form (admins); restricted spaces list with members and create/delete (delete behind a confirm dialog with the Task 8 text); "Sign out of this server" button (all roles); when `needsSignIn` or the overview call throws `HubUnauthorized`, a `Banner` "Sign in to the server again" with a button that starts the connect flow (`/sign-in?connect=1`). `HubForbidden` shows "You were removed from this team." Server actions in `hub-team-actions.ts` follow the `team-actions.ts` pattern (`run`, `requireViewer`, revalidate `/team`).

- [ ] **Step 1: Write failing tests**: with `MERGEPORT_HOME/active.json` set to github (or absent) the page module's GitHub path is taken (spy on `getTeamService` called, `getHubTeamService` not called); with a hub backend the opposite, and no `TeamService` method is called; actions reject a non-admin before reaching the api; `HubUnauthorized` renders the re-sign-in text (render to string with `react-dom/server`). Re-run `tests/team-sync.test.ts`, `tests/join-consent.test.ts`, `tests/revoke-space.test.ts` unchanged.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Check in the Browser pane (desktop + 390 px, light + dark) against `DESIGN.md`. **Step 4:** Tests + typecheck + lint → PASS. **Step 5:** Commit `feat: hub-mode Team page`.

---

### Task 10: Docs and full verification

**Files:** Modify `docs/architecture.md`, `README.md` (one paragraph: Workspaces and Connect to a server).

- [ ] **Step 1:** Add to `docs/architecture.md`: profile keys and registry files, supervisor/control channel, the plan-2 integration seam (`ports.ts` ↔ `HubClient/HubSession/HubLink`, `currentBackend()` ↔ `TeamConfig.backend`, `assertBackendMatch` call in the engine) as a checklist, and the spec's manual verification list (hub behind Caddy with real TLS, two real GitHub accounts, invite, join, edit, remove) marked not yet run.
- [ ] **Step 2:** Run `npm run typecheck`, `npm run lint`, `npm test`. Expected: all pass, existing suites unchanged (`git diff main --stat -- tests` shows only added files).
- [ ] **Step 3:** Commit `docs: hub profiles and switching`.

---

## Self-Review notes

- Spec coverage: profiles/registry (T1), supervisor+switch (T2–4), `profile-switch.test.ts` (T4), sign-in card + health/device flow + gh id match (T5–6), switcher (T7), HubTeamService and page incl. 401 and connection state (T8–9), session storage via port (T5; real storage arrives with plan 2).
- Deliberately not covered here: hub token encryption, `HubLink`, `Space.backend` engine wiring (plan 2); the hub itself (plan 1). Seams listed in T10.
