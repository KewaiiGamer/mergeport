# Instant GitHub updates through the hub: relay (webhooks via a GitHub App)

Date: 2026-10-30. Status: approved in chat. Option 3 of the options discussed: GitHub sends signed webhooks to the hub, the hub relays each event to the apps that may see it, and each app applies the common events straight to its local database with no GitHub request; events whose effect cannot be applied safely from the payload fall back to a fetch of that repository with the person's own `gh`. The webhooks come from one GitHub App that the form creates through GitHub's manifest flow (confirmation clicks on GitHub are accepted).

## Intent

GitHub issues, pull requests, reviews and checks reach each Mergeport app through that person's own `gh`, polled every 15 minutes (`RECONCILE_EVERY_MS`). People using the hub need them within about a second and without spending their GitHub rate limit. GitHub can only push to a public address, and a hub is one.

## Goals

- A change on GitHub shows in every connected app that tracks that repository within about 2 s.
- Zero GitHub requests for the common events (issues, issue comments, pull request state and fields, inline review comments); a fetch only for the others.
- No GitHub token on the hub, no GitHub content stored or logged on the hub: a delivery passes through memory and is relayed.
- Setup is done in the app: the form creates the App, the hub's secret is stored without touching the server, tracked repositories are added to the App through the API where GitHub allows it.
- GitHub-only mode and hubs without webhooks are unchanged and keep the 15-minute cycle, which also remains the safety net for offline apps and missed events.

## Non-goals

- Storing GitHub data on the hub, or hub-side GitHub API calls (a later phase).
- Replacing the 15-minute cycle.
- Applying review, check, status, branch or review-request events from payloads (they fall back to a fetch).
- Changing Cloudflare or other infrastructure (the app only detects and explains a block).
- Using or keeping the App's private key or client secret.

## Protocol (fixed; hub and app are built against exactly this)

### Hub storage

New `setting` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`; migration `hub/migrations/20261101000000_settings/migration.sql`). Keys: `github_webhook_secret` (the App's webhook secret, 32 to 256 characters) and `github_app_slug`. The env var `MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET` is an optional fallback used only when the table holds no secret. The secret is cached in memory and the cache is replaced when it changes. It is never returned by any route and never logged.

### Hub routes

- `PUT /admin/github-webhook` with `{ "secret": string (32 to 256 chars), "appSlug"?: string (letters, digits, hyphens, max 100) }`: OWNER only (other roles `403`, no session `401`); stores both; `204`.
- `DELETE /admin/github-webhook`: OWNER only; removes both keys; `204`.
- `POST /webhooks/github` (no bearer; authenticated by signature only):
  1. No secret from either source: `404`.
  2. Body read raw, at most 1 MiB (`413` above). `X-Hub-Signature-256: sha256=<hex>` must equal the HMAC-SHA256 of the raw body with the secret, compared with `timingSafeEqual`; missing, malformed or wrong: `401` and nothing else happens.
  3. `X-GitHub-Event: ping`, `installation` and `installation_repositories`: `200 {"ok":true}`, recorded in the status, not relayed.
  4. Relayed events: `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`, `check_suite`, `status`, `push`, `create`, `delete`. Any other event: `202`, ignored.
  5. From the JSON body the hub reads `repository.id` (number), `repository.private` (boolean), `repository.owner.login` (string); if any is missing: `400`.
  6. Dedupe: `X-GitHub-Delivery` ids seen in the last 10 minutes (in memory, at most 5000) answer `200 {"ok":true,"notified":0}` and are not relayed again.
  7. One shared rate bucket, 600 requests per minute; over it `429` with `Retry-After`.
  8. Never stored, never logged: body, signature, secret, titles. Logged: event name, repository id, number of sockets notified.
  9. Answers `200 {"ok":true,"notified":<n>}` after sending the relay to each allowed connection (below) and records the delivery in the status.

### Hub and app over the WebSocket

- Hub to app, per allowed connection, immediately and in arrival order (no coalescing): `{ "t": "gh", "repoId": "<decimal string>", "event": "<event name>", "delivery": "<X-GitHub-Delivery>", "payload": <the parsed JSON body, or null> }`. `payload` is `null` when the raw body is larger than 256 KiB, which makes the app fetch instead.
- App to hub: `{ "t": "watch", "repos": ["<decimal string>", ...] }` replaces the connection's watched set (at most 2000 ids, extra ignored); sent after `hello` and whenever the tracked set changes; held in memory per connection.

### Who receives a relay (the audience rule)

A connection receives it for repository R only if it watches R and its member is allowed:
1. R is public (`repository.private` false), or
2. the member's login equals `repository.owner.login` (case-insensitive), or
3. R is shared through a space the member can read: some non-deleted `entity` row of type `repo`, in a space where `spaceAccess(member).canRead` is true, has `data.githubId` equal to R's id.
Otherwise nothing is sent; that member's app covers it on the 15-minute cycle.

### Status

`GET /me` gains `webhooks: { enabled: boolean, appSlug: string | null, lastDeliveryAt: string | null, lastEvent: string | null }`. `enabled` is true when a secret exists from either source; the last two fields are kept in memory; `lastEvent` is the event name only. `GET /health` is unchanged.

## App behaviour

### Receiving

`HubClient` gains `me().webhooks`; the admin API gains `setGithubWebhook(secret, appSlug)` and `clearGithubWebhook()`. `HubLink` dispatches `gh` messages to a new option `onGithubEvent(e: { repoId: string; event: string; delivery: string; payload: unknown | null })` and has `watch(repoIds: string[])`, called after `hello` and when the tracked set changes. The watched set is the profile's `Repository` rows with `trackingStatus = ACTIVE` (GitHub ids as decimal strings).

### Applying (`src/lib/hub/gh-events.ts`)

`handleGithubEvent(db, e)`:
1. Ignore unless a local `Repository` with that GitHub id is `ACTIVE`. Ignore a `delivery` seen in the last 200 deliveries.
2. If `payload` is null, or the event is not a direct-apply one, or any field the mapping needs is missing or of the wrong type: **fallback** (below) and stop.
3. **Direct apply**, using the same write functions the full sync uses (`applyWorkItem` in `src/lib/sync/repository.ts` and the `WorkItemComment` upsert), so rules such as "never write an older `updatedAt`" (`shouldApplyUpdate`) hold:
   - `issues` (any action): `payload.issue` to a `RemoteWorkItem` of type `ISSUE`.
   - `pull_request` (any action except `review_requested` and `review_request_removed`, which fall back): `payload.pull_request` to a `RemoteWorkItem` of type `PULL_REQUEST` with the PR fields the sync stores (head and base ref, head sha, draft, additions, deletions, changed files, merged state). `mergeable` is taken only when the payload has a boolean; otherwise the stored value is kept. When the head sha changed, the checks state becomes `PENDING` until the check events fall back to a fetch.
   - `issue_comment`: `created` and `edited` upsert the `WorkItemComment` (kind `ISSUE_COMMENT`, by GitHub comment id) of the matching work item (created locally if absent); `deleted` removes it.
   - `pull_request_review_comment`: same with kind `REVIEW_COMMENT`, including path, line, commit sha and thread key as the sync stores them.
4. Fallback events: `pull_request_review`, `pull_request_review_thread`, `check_run`, `check_suite`, `status`, `push`, `create`, `delete`, review-request actions, and any direct-apply event that failed the checks in step 2.
5. After a direct apply, emit `notifyChange("pulled")` so `LiveRefresh` redraws within about 0.6 s.

**Fallback = repository refresher:** coalesce per repository for 1500 ms; one refresh at a time per repository; at most one per repository every 5 s (a request inside that window is delayed to its end, not dropped); the refresh is the same service call the Repositories page's Refresh button uses; its completion emits `notifyChange("pulled")`.

A malformed event never throws out of the message handler and never blocks later ones.

### Creating the App (manifest flow)

GitHub's manifest flow lets the form create the App with one confirmation click. No password or admin token is involved.

Local routes under `/api/local/hub/github-app/`, with the same guards as the other hub routes (loopback Host, session cookie, hub session present); `start` also requires the hub role OWNER, checked through the hub's `/me`:
- `POST start` with `{ "account": "personal" }` or `{ "account": "org", "org": "<login>" }`, `{ "contents": boolean }` and `{ "teammates": boolean }` returns `{ actionUrl, manifest, state }`. `actionUrl` is `https://github.com/settings/apps/new?state=<state>` or `https://github.com/organizations/<org>/settings/apps/new?state=<state>`. `state` is 32 random bytes (base64url) kept in memory with the hub origin and a 15-minute expiry, single use. The page submits a hidden form (`method=post`, one field `manifest`) to `actionUrl` as a top-level navigation.
- `GET callback?code=<code>&state=<state>`: requires a known, unexpired, unused `state` (otherwise a plain error page with a link to Team and no call to GitHub). Then `POST https://api.github.com/app-manifests/<code>/conversions` with no auth and a 15 s timeout. It keeps only `webhook_secret` and `slug`; `pem`, `client_secret`, `client_id`, `id` are dropped immediately, never stored, logged or forwarded. It calls the hub `PUT /admin/github-webhook { secret, appSlug }` with the owner's session and redirects to `/team?github-app=created`. Any failure redirects to `/team?github-app=failed&reason=<short code>`; no secret appears in any URL.

Manifest:
```
{
  "name": "Mergeport <team name> <4 random lowercase letters>",
  "url": "<hub origin>",
  "hook_attributes": { "url": "<hub origin>/webhooks/github", "active": true },
  "redirect_url": "http://127.0.0.1:<this app's port>/api/local/hub/github-app/callback",
  "public": <teammates>,
  "request_oauth_on_install": false,
  "default_permissions": { "issues": "read", "pull_requests": "read", "checks": "read", "statuses": "read", "metadata": "read" },
  "default_events": ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment", "pull_request_review_thread", "check_run", "check_suite", "status"]
}
```
With `contents: true` it adds `"contents": "read"` and the events `push`, `create`, `delete`. `public: true` lets teammates install the App on their own repositories (a private App can only be installed by its creator's account); the guide explains this in one sentence and defaults it on. GitHub shows the prefilled App; the person may change the name (it must be unique) and presses "Create GitHub App".

### Installing on repositories

After creation the person installs the App once on GitHub (a page with a confirmation). For further repositories the app tries the API first: `GET /user/installations` (filter `app_slug`) then `GET /user/installations/{installation_id}/repositories`, and for tracked repositories not yet covered `PUT /user/installations/{installation_id}/repositories/{repository_id}` (through the person's `gh`, scope `repo`), one request each, only when the person presses "Add my tracked repositories". A `403` or `404` (for example the installation is on "All repositories", or the person does not own the repository) is reported per repository as "Install it on this repository on GitHub" with a link to `https://github.com/apps/<appSlug>/installations/new`.

## The panel in the app (Team page, hub mode)

A panel "Instant GitHub updates" under the connection status. Everyone sees one status line from the live state: "Instant GitHub updates are on" (a delivery arrived in the last 24 hours), "Waiting for the first event from GitHub" (enabled, nothing yet), or "Not set up". Only the OWNER sees and runs step 1; everyone runs steps 2 and 3 for their own repositories.

1. **Create the GitHub App** (OWNER): radio "my GitHub account" or "an organisation" (with a login field), checkbox "Let teammates install it on their own repositories" (on), checkbox "Also refresh branches and commits instantly" (contents, off), button "Create the GitHub App on GitHub". After GitHub redirects back: "Created. The secret is saved on your server." Done is read from `/me.webhooks.enabled`.
2. **Cover your repositories** (each person): a table of this profile's tracked repositories with *Covered* or *Not installed yet*; the button "Add my tracked repositories" (the API route above) and a link to the App's install page for the rest. If the person has not installed the App at all, the first step is the install page link.
3. **Check**: "Check now" re-reads `/me`. If enabled with no delivery: "Install the App on a repository (GitHub sends an event when you do), then edit an issue to see it arrive instantly." Plain sentences for failures; if deliveries cannot reach the hub: "GitHub could not reach the server. If Cloudflare is in front, add a skip rule for the path /webhooks/github."

A collapsed "Set it up by hand" section (OWNER) for a person who cannot use the manifest flow: one "Generate" button fills every value in the browser (nothing leaves it except through the Save button): App name, homepage and webhook URLs (copy buttons), a 64-hex-character secret from `crypto.getRandomValues` (copy), the permissions table and events list (copy-all), and "Save secret on the server" calling `PUT /admin/github-webhook`; "Turn off" calls `DELETE /admin/github-webhook` after a confirmation.

The Repositories page shows a small badge per repository: *Instant* (covered) or nothing. Both follow `DESIGN.md`; errors are plain sentences.

## Security notes (to be written into `hub/README.md`)

- The endpoint is public and authenticated by HMAC with the App's webhook secret, which lives in the hub's database file (a backup of `hub.db` contains it). It proves a delivery came from GitHub and grants no repository access.
- The hub holds a delivery in memory only while verifying and relaying it. It relays full payloads, which may contain private repository content, only to connections allowed by the audience rule. Apps trust the hub (they already trust it for shared data).
- The App is created with read-only permissions. Its private key and client secret are discarded unread.
- Cloudflare in front: if Bot Fight Mode or a WAF rule challenges `GitHub-Hookshot/*`, add a skip rule for `/webhooks/github`; failures show in the App's Recent deliveries.

## Verification required

- Hub webhook tests: valid signature accepted; wrong, missing, truncated signatures `401`; body over 1 MiB `413`; `ping`, `installation`, `installation_repositories` recorded not relayed; unknown event `202`; missing repository fields `400`; duplicate delivery id relayed once; `404` with no secret; the relay carries the payload and is `payload: null` above 256 KiB; relays arrive in order; the audience matrix (public with a watcher, private with the owner's login, private shared in a readable space, private shared only in an unreadable restricted space, private with an unrelated watcher, public without a watcher); `watch` replaces the set and caps at 2000; no log line or response contains a body or secret.
- Hub admin tests: `PUT /admin/github-webhook` as OWNER stores the secret (signatures made with it then verify), as ADMIN or MEMBER `403`, no session `401`, secret under 32 characters `400`; `DELETE` returns the endpoint to `404` (no env fallback set); the env fallback works when the table is empty; the secret appears in no response or log; `/me.webhooks` reflects state.
- App event tests with realistic GitHub payload fixtures under `tests/fixtures/github-webhooks/` (issues opened, edited, closed with labels and assignees; pull_request opened, synchronize, closed merged, ready_for_review; issue_comment created, edited, deleted on an issue and on a PR; pull_request_review_comment created): each direct-apply event writes the same rows a full sync would for the same data (a test runs the sync mapping on the equivalent API object and compares the stored fields); an older `updated_at` never overwrites a newer row; unknown or malformed shapes fall back without throwing; the fallback refresher merges a burst into one refresh, never overlaps for one repository and delays a second refresh inside 5 s; a delivery id seen twice applies once; events for untracked repositories are ignored; `notifyChange("pulled")` fires after an apply.
- App link tests: `HubLink` calls `onGithubEvent` and sends `watch` after `hello`; the watched set follows tracking.
- App manifest-flow tests: `start` builds the manifest with the hub's origin and the app's own port, refuses non-OWNER and non-loopback requests, returns a single-use expiring state; `callback` rejects an unknown, reused or expired state without calling GitHub; against a fake GitHub it sends only `secret` and `appSlug` to the hub (a test asserts the pem and client secret are absent from every outgoing request, log line and redirect URL); a conversions failure redirects with `github-app=failed` and leaves the hub untouched. Installation helper: adds only uncovered tracked repositories, reports `403` and `404` per repository.
- Panel tests: step 1 only for the OWNER; the hidden form is built from `start`'s answer; each status has its text; "Generate" fills every value and the secret is 64 hex characters.
- All existing tests pass; `tests/team-sync.test.ts` and `tests/review-fixes.test.ts` unchanged.
