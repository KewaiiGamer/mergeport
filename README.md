# Mergeport

A local-first control center for selected GitHub repositories: review queues ("I should review" vs "waiting on someone else"), planning across repositories, fork and upstream tracking, and read-only visibility of local worktrees. It runs on **your own computer**. A team shares planning state through private GitHub repositories, not through a server.

Visual character follows <https://kravio-dashboard.vercel.app/> (`DESIGN.md`), in light and dark. Product intent is in `PRODUCT.md`; the design of the system is in `docs/architecture.md`.

> Status: implemented and tested against a simulated GitHub, and exercised **read-only** against one real GitHub account (discovery, 56 tracked repositories, issues, pull requests, reviews, checks, forks, sync and recovery; see `docs/real-github-verification.md`). **Team collaboration has not been run with two real accounts** (`docs/team-test.md` is the prepared plan); no repository was created and no invitation was sent. See "What is verified" below.

## What it looks like

All screenshots use the built-in synthetic demo data (`npm run local:demo`): made-up people, repositories and pull requests, nothing from a real account.

| | |
| --- | --- |
| ![Overview](docs/screenshots/overview.png) **Overview**: what needs you, what waits on others, what is blocked. | ![My attention](docs/screenshots/attention.png) **My attention**: queues grouped by repository, the reason behind each behind "Why". |
| ![Planning board](docs/screenshots/planning-board.png) **Planning board**: cross-repository cards; dragging never changes GitHub. | ![Pull requests](docs/screenshots/pull-requests.png) **Pull requests**: review state, checks and mergeability. |
| ![Projects](docs/screenshots/projects.png) **Projects**: group repositories, required reviewers, sharing. | ![Review routing](docs/screenshots/review-routing.png) **Review routing**: who must review, and who work waits on. |
| ![Repositories](docs/screenshots/repositories.png) **Repositories**: owner type, access, sync state. | ![Forks](docs/screenshots/forks.png) **Forks and upstream**: real commit divergence. |
| ![Light theme](docs/screenshots/overview-light.png) **Light, dark or system theme.** | <img src="docs/screenshots/phone-overview.png" alt="Phone layout" width="260"> **Phone layout.** |

## What you need

- **Node 24** (declared in `engines`: `>=24 <25`) and npm 10 or newer. The SQLite binding ships prebuilt inside the package (Windows, macOS and Linux; only Windows x64 was exercised) so nothing is compiled during install.
- The [GitHub CLI](https://cli.github.com/) (`gh`), signed in: `gh auth login` (details and honest scope notes in `docs/github-cli-setup.md`). Mergeport never stores or logs your token and never sends it to the browser. It asks `gh` for the token of THIS profile's account at run time, keeps it in memory, and hands it to `gh` through the child process's environment (never an argument). See "Account binding" below.
- Nothing else. No Docker, no Postgres, no VPS, no tunnel, no webhooks, no shared `.env`.

## Quick start

```bash
npm ci                 # install exactly what package-lock.json says; also generates the Prisma client (postinstall)
npm run local          # signs in as your gh account, opens the app on 127.0.0.1
npm run local:demo     # synthetic data, no GitHub at all
```

`npm run local` works out who `gh` is signed in as, opens **that account's own SQLite profile** (`~/.mergeport/profiles/<host>-<numeric id>/mergeport.db`), starts the server on `127.0.0.1` only, and opens your browser on a one-time launch link. The first run builds the app once (about half a minute). Stop it with **Ctrl+C**. In `cmd.exe`, Windows may then ask "Terminate batch job (Y/N)?": that prompt comes from npm's own `npm.cmd` wrapper after the app and every `gh` process it started have already ended; answer Y. PowerShell does not ask.

Demo mode keeps its own database under `~/.mergeport/demo/`. Everything in it is synthetic and labelled, and actions change that database only.

## Personal and Team

- **Personal** (default): everything stays on this computer. Repositories you track, boards, internal tasks, waiting notes, local worktrees.
- **Team**: you can additionally create or join a team. Mergeport-owned data (project configuration, board state, internal tasks, cross-repository milestones, routing, waiting annotations, triage decisions) is stored as small JSON files in **private GitHub repositories** and synced by every member's local copy. GitHub itself stays the source of truth for issues, pull requests, reviews and labels; each person fetches those with their own access and caches them locally.

Create, invite and join are in the app (**Team**). Creating a team shows the exact repository name, owner, visibility and permissions first and does nothing until you confirm. See `docs/architecture.md`.

Teams can alternatively run their own small **hub server** (one Node process and one SQLite file) instead of GitHub repositories for Mergeport-owned data; see `hub/README.md` to host one.

### Reviewing code

Pull requests open on **Conversation**, **Files changed** and **Commits** tabs that switch instantly (the diff is fetched once, cached by commit, and warmed in the background). The diff looks like GitHub's: a file tree, unified or split layout, line numbers on both sides, Primer syntax colours in light and dark, expandable context between hunks, per-file **Viewed** marks that reset when the file changes again, each commit reviewable on its own, existing inline comments, and new inline comments posted to GitHub as you. **Repositories → Browse code** opens any tracked repository at any branch with a folder view, README, and highlighted files with line anchors. Code blocks in Markdown use the same colours.

### Tasks

**Tasks** is a GitLab-style work list on top of the planning cards: create a task, give it to someone by GitHub username, set status, priority, due date and labels, and discuss it in a comment thread with a history of who changed what. Filters: assigned to me, assigned by me, unassigned, all. Tasks assigned to you also show in **My attention**. In a team, tasks and comments sync like the rest of the shared data, so a task you assign appears on your teammate's computer.

### Joining an existing team

1. Accept the GitHub invitation (Team page, or from GitHub).
2. Open **Team**. Private `mergeport-*` repositories your account can read are listed with what they are and what joining downloads.
3. Review one and confirm. Projects, cards, review rules, waiting rules, fork mappings and the shared repository list then arrive on their own and stay in sync. Nothing is joined without that confirmation.

Repositories the team shares are matched to your own GitHub access; a repository you cannot read shows up as shared but unavailable to you.

### Workspaces and connecting to a server

The top bar has a workspace switcher. Each workspace (GitHub, or a team server) is a separate local profile, so data never mixes. To use a team server, choose **Connect to a server** on the sign-in card, enter its address and approve the GitHub code it shows. Mergeport must be signed in to `gh` as that same GitHub account. Switching restarts the app in place and shows a short "switching" overlay. See `docs/architecture.md`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run local` / `npm run local:demo` | Start Mergeport for your gh account / with demo data |
| `npm run dev` | Next.js dev server on `127.0.0.1:3000` using `./.data/dev.db` (development only) |
| `npm run build` / `npm start` | Production build (runs `prisma generate`) / serve it |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm test` | Vitest. Each test uses its own SQLite files; no services needed |
| `npm run db:seed` | Seed synthetic data into the dev database |
| `npm run migrate:from-postgres -- --from <url> --login <you>` | Import a legacy Postgres install (`docs/migration.md`) |

## Light, dark, system

Settings has **Light / Dark / System**, and the top bar has a quick toggle. The choice is stored on this device only (a first-party cookie, never synced to a team). The server renders it into the first byte of HTML, so there is no flash and no hydration mismatch. System follows the OS and updates live.

## Security model in brief

- **Account binding.** Every GitHub call runs as the account the profile was created for, identified by its immutable numeric user id, never as whichever account `gh` has selected at that moment. A switch with `gh auth switch` before, during or after a call cannot change who it runs as. If that account is not signed in, is a different id, or the CLI is too old, the call is **blocked** and you are asked to reconnect; nothing falls back to another account or an inherited `GH_TOKEN`.

- The server binds to `127.0.0.1`. A guard refuses any `Host` that is not loopback (DNS rebinding) and any state-changing request that is not same-origin.
- The browser gets a session cookie only through the one-time launch link the launcher opens. Other pages in your browser cannot use the app.
- GitHub calls are `gh api` with an argument array, never a shell string, each with a timeout and cancellation that kill the whole process tree. Credential headers are dropped. Tokens, keys, local paths, logs and worktree snapshots never enter a shared repository.
- **Joining is explicit.** Mergeport finds candidate coordination repositories and shows what each is; nothing is joined or imported until you press Join and confirm.
- **Pages never wait on GitHub.** Team and Connect render from the last saved result with its age; GitHub is asked in the background, and a failure keeps the saved list and says why (offline, rate limited, sign-in needed).
- Privacy is a real boundary: a restricted audience gets its **own private repository**. Data a person may not see is never written to a repository they can read, and is never merely hidden in the UI.
- Roles come from GitHub's permission on the team repository, not from a field in a file anyone can edit. A forged `role: "admin"` in a local database or a shared file grants nothing.
- A coordination repository is data. Mergeport never executes, installs or follows instructions from one.

## What is verified

See "Verification record" in `docs/architecture.md`. In short, automated: two isolated local clients (separate databases) against a simulated GitHub coordination service, covering live propagation, concurrent edits, same-record conflicts, duplicate retries, offline and reconnect, deletion, restart, schema mismatch, revoked access, rate-limit exhaustion, privacy of the common repository, forged roles, and mocked team creation, invitation and join flows; the scheduler recurrence regression; the `gh` transport; the loopback guard; the Postgres import. In a real browser (demo mode): light, dark and system, refresh persistence, mobile width, the sliding tab pill, board card movement and toasts.

**Not verified:** real two-account team collaboration (create, invite, join, revoke); real network loss (it was simulated at the `gh` boundary); SAML/SSO and organization-approval prompts; discovery of more than 100 repositories; operating-system reduced-motion setting, touch devices, and the Windows installer path for `gh`.
