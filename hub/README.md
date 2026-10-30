# Mergeport hub

A small self-hosted server for a Mergeport team: members, roles, spaces, and a synced entity log with live change notifications. One Node process and one SQLite file.

## Requirements

- Node 24
- A domain name pointing at the machine
- A reverse proxy that terminates TLS (Caddy below)
- The `sqlite3` command-line tool (for backups)

## 1. Register a GitHub OAuth App

GitHub, Settings, Developer settings, OAuth Apps, New OAuth App.

- Homepage URL: the hub's public URL, for example `https://hub.example.com`
- Enable **Device Flow**
- No callback URL is needed (device flow does not use one; if the form insists, reuse the homepage URL)

Copy the **Client ID**, then generate and copy a **Client secret**.

## 2. Configure

Create a `.env` file (never commit it):

```
MERGEPORT_HUB_DATA=/var/lib/mergeport-hub
MERGEPORT_HUB_PUBLIC_URL=https://hub.example.com
MERGEPORT_HUB_GITHUB_CLIENT_ID=<client id>
MERGEPORT_HUB_GITHUB_CLIENT_SECRET=<client secret>
MERGEPORT_HUB_OWNER_LOGIN=<your GitHub login>
MERGEPORT_HUB_PORT=8787
MERGEPORT_HUB_TRUST_PROXY=true
```

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MERGEPORT_HUB_DATA` | yes | | Directory holding `hub.db` (created if missing). |
| `MERGEPORT_HUB_PUBLIC_URL` | yes | | Public URL, should be https; must match the OAuth App homepage. |
| `MERGEPORT_HUB_GITHUB_CLIENT_ID` | yes | | OAuth App client id. |
| `MERGEPORT_HUB_GITHUB_CLIENT_SECRET` | yes | | OAuth App client secret. |
| `MERGEPORT_HUB_OWNER_LOGIN` | yes | | GitHub login of the person who becomes the team owner. Only this login (compared case-insensitively) can sign in to an empty hub; everyone else is refused as not invited until the owner has signed in and invited them. |
| `MERGEPORT_HUB_PORT` | no | `8787` | Listen port. |
| `MERGEPORT_HUB_TRUST_PROXY` | no | `false` | Set `true` only when a reverse proxy fronts the hub (the Caddy setup below): it binds `127.0.0.1` only and takes the client IP from the rightmost `X-Forwarded-For` entry (used for rate limits). The default `false` uses the socket address and binds `0.0.0.0` only when the public URL is https (otherwise still loopback). Never leave it `false` behind a proxy (every client would share the proxy's rate limit) and never set `true` when clients can reach the hub directly (they could spoof the header). |
| `MERGEPORT_HUB_BIND_HOST` | no | derived | Explicit bind address, overriding the rule above. Set `0.0.0.0` inside a container that a reverse proxy reaches over a Docker network (the Docker setup below); never expose that container's port on the host. |
| `MERGEPORT_HUB_GITHUB_WEBHOOK_SECRET` | no | | Fallback webhook secret (32 to 256 characters), used only while the hub's database holds none. Normally leave it unset: the owner saves the secret from the Mergeport app (see "Instant GitHub updates" below). |
| `MERGEPORT_HUB_GITHUB_API_BASE` | no | `https://api.github.com` | Tests only. Points the hub at a fake GitHub API. |
| `MERGEPORT_HUB_GITHUB_OAUTH_BASE` | no | `https://github.com` | Tests only. Points the hub at a fake GitHub OAuth host. |

Invalid or missing configuration stops the hub at start with a message naming the variables.

## 3. Run

```
npm ci
npm run hub
```

Load the `.env` with your process manager (systemd below) or your shell. The first sign-in by `MERGEPORT_HUB_OWNER_LOGIN` bootstraps the team (named `<login>'s team`) with that person as owner; any other login is refused on an empty hub, so nobody can claim the hub before you do. Everyone else needs an invite from an owner or admin. `GET /health` reports `bootstrapped: false` until the owner has signed in.

## 4. Reverse proxy (Caddy)

This setup needs `MERGEPORT_HUB_TRUST_PROXY=true` in `.env` (it is `false` by default).

```
hub.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Caddy gets the certificate, forwards WebSockets, and sets `X-Forwarded-For`.

With nginx, set the header explicitly: `proxy_set_header X-Forwarded-For $remote_addr;` (not `$proxy_add_x_forwarded_for`, which appends to a client-supplied value and lets clients dodge the per-IP rate limit). Also forward WebSockets (`proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection upgrade;`).

## 4b. Docker behind Nginx Proxy Manager (or any proxy on a Docker network)

`hub/Dockerfile` and `hub/docker-compose.yml` run the hub as one container with no host port. The proxy reaches it over a shared Docker network, so the hub binds `0.0.0.0` inside the container (`MERGEPORT_HUB_BIND_HOST`) and trusts the proxy's `X-Forwarded-For`.

```bash
git clone -b <branch> https://github.com/<owner>/mergeport mergeport-hub && cd mergeport-hub/hub
cp .env.example .env            # fill in the values; chmod 600 .env
docker network create nginx_mergeport_network
docker network connect nginx_mergeport_network <proxy container name>
docker compose up -d --build
```

In Nginx Proxy Manager add a proxy host: domain = the public URL's host, scheme `http`, forward host `mergeport-hub`, port `8787`, **Websockets Support** on, **Block Common Exploits** on, SSL with a Let's Encrypt certificate and **Force SSL**. NPM sets `X-Forwarded-For` to the client address. Data lives in the `mergeport_hub_data` volume (`/data/hub.db` in the container); back up with `docker compose exec hub sqlite3 /data/hub.db ".backup /data/hub-$(date +%F).db"`.

## 5. systemd

`/etc/systemd/system/mergeport-hub.service`:

```
[Unit]
Description=Mergeport hub
After=network.target

[Service]
Type=simple
User=mergeport
WorkingDirectory=/opt/mergeport
EnvironmentFile=/etc/mergeport-hub.env
ExecStart=/usr/bin/node --import tsx hub/src/main.ts
Restart=on-failure
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Adjust the `node` path and `WorkingDirectory` to your install. Then `systemctl enable --now mergeport-hub`. The hub closes cleanly on SIGTERM.

## Backup

SQLite online backup, safe while the hub runs:

```
sqlite3 hub.db ".backup hub-$(date +%F).db"
```

Run it from `MERGEPORT_HUB_DATA`. Back up that file; it is the whole state.

### Restoring

Stop the hub, delete `hub.db`, `hub.db-wal` and `hub.db-shm`, copy the backup to `hub.db`, start the hub. **Everything written after the backup is gone from the hub**, including the sessions and members added since, so people sign in again and removed members may be back.

Clients do not silently follow a restored hub. Each hub process has its own id, and a client that sees a different one compares its data with the hub's before replacing anything:

- Local edits that were not sent yet are kept, merged against the restored data, and sent.
- Saved copies that were newer than the restored hub are replaced by the hub's version, and each person sees a notice on the Sync page ("Server restored from a backup") listing what was replaced. From there they can send their newer copies back to the server or keep the server's version.
- A restart of the same database (no restore) also makes each client compare once, and shows nothing when nothing differs.

Tell your team before you restore: whatever they did after the backup has to be re-sent by them if you want it back.

## Upgrade

Stop the hub, `git pull`, `npm ci`, start it. Migrations apply at start. A database written by a newer hub is refused, so roll back the code rather than the data.

## Behaviour worth knowing

- **Sessions** last 30 days and slide: every authenticated request extends them.
- **Rate limits**: 60 requests per 10 s per session; 10 device-flow starts per minute per IP. Over the limit answers `429` with `Retry-After` (seconds).
- **Ops body cap**: a push request body is capped at 16 MiB; larger answers `413`. Clients should batch ops by byte size.
- **Reading events**: `GET /spaces/:id/entities?since=<seq>` returns `{ epoch, seq, seqOp, events, more }`, in pages of 500 (`limit` can lower that). A client must loop until `more` is `false`, using the returned `seq` as the next `since`.
- **Removed members**: removing a member revokes their sessions and their restricted-space access. The owner can reinstate them later (Team page, or `POST /admin/members/:githubId/reinstate {"role":"MEMBER"}`); they return to the common space only and are added to restricted spaces again on purpose.
- **Event log pruning**: old events are pruned. Sessions with no cursor for a space do not hold pruning back. A client whose `since` has been pruned gets `410` and re-snapshots that space.
- **Logs**: one JSON line per request (`method`, `path`, `status`, `ms`, `member` when known). Never bodies, query strings, session tokens, GitHub tokens, device codes or user codes.

## Instant GitHub updates (webhook endpoint)

The hub can relay GitHub webhooks to the Mergeport apps that track the repository, so a change on GitHub shows within about a second without each person spending their GitHub rate limit. The owner sets this up from the Mergeport app (Team page, "Instant GitHub updates"): the app creates a GitHub App whose webhook URL is `https://<your hub>/webhooks/github` and saves its webhook secret on the hub with `PUT /admin/github-webhook` (owner only). The owner does not edit the server. `DELETE /admin/github-webhook` turns it off. Without a secret the endpoint answers `404`, and hubs without it behave as before.

How it works:

- `POST /webhooks/github` has no bearer token. It is authenticated only by `X-Hub-Signature-256`, the HMAC-SHA256 of the raw body with the secret (compared in constant time). The body is capped at 1 MiB (`413`); a missing or wrong signature is `401` and nothing else happens.
- `ping`, `installation` and `installation_repositories` are recorded (`GET /me` shows `webhooks.lastDeliveryAt` and `lastEvent`, held in memory) and not relayed. `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`, `check_run`, `check_suite`, `status`, `push`, `create` and `delete` are relayed over the WebSocket as `{"t":"gh", ...}` to the connections that asked for that repository (`{"t":"watch","repos":[...]}`) and are allowed to see it: the repository is public, or its owner is the member (by GitHub id), or it is shared through a space the member can read. Everyone else's app catches up on its 15-minute cycle. Any other event is ignored (`202`).
- Deliveries repeated within 10 minutes (same `X-GitHub-Delivery`) are relayed once. The endpoint shares one bucket of 600 requests per minute (`429` above it). A payload over 256 KiB is relayed as `payload: null`, which makes the app fetch instead.
- Logs carry the event name, the repository id and the number of sockets notified. Never a body, a title, a signature or the secret.

Security notes:

- The endpoint is public and authenticated by HMAC with the App's webhook secret, which lives in the hub's database file (a backup of `hub.db` contains it). It proves a delivery came from GitHub and grants no repository access.
- The hub holds a delivery in memory only while verifying and relaying it. It relays full payloads, which may contain private repository content, only to connections allowed by the audience rule above. Apps trust the hub (they already trust it for shared data).
- The App is created with read-only permissions. Its private key and client secret are discarded unread.
- Residual and deliberate: the response code reveals whether webhooks are configured (`404` without a secret, `401` with one). Events are relayed in the order their bodies finish arriving, and apps never write older data over newer. A captured signed delivery can be replayed after the 10 minute dedupe window; it only makes apps refresh.
- Limits: at most 16 webhook bodies are read at once (the next answers `503` with `Retry-After: 1`); a body past 1 MiB is refused as soon as it passes the limit and the connection is cut. On the WebSocket, `watch` frames may be up to 64 KiB and every other client frame 4 KiB; more than 30 client frames in 10 s closes the socket (1008).
- A private repository is relayed to its owner by the owner's numeric GitHub id (`repository.owner.id`); the login is compared (case-insensitively) only when the payload has no numeric owner id.
- Cloudflare in front: if Bot Fight Mode or a WAF rule challenges `GitHub-Hookshot/*`, add a skip rule for `/webhooks/github`; failures show in the App's Recent deliveries.

## What the hub stores

- Members (GitHub id, login, name, avatar URL), roles, invites
- Sessions, as SHA-256 hashes of the token, with expiry and client name
- Spaces, space membership, and the synced entity records and their change log
- The GitHub App's webhook secret and slug, when instant updates are set up (table `setting`)

It never stores GitHub tokens: the access token from sign-in is used once to read your GitHub profile and is then dropped. It stores no source code, no issues and no pull requests; GitHub stays the source of truth for those.
