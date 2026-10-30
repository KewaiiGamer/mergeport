# Hub test on a real VPS

A manual run of the hub behind real TLS with two real GitHub accounts. Record the outcome in `docs/architecture.md` (Verification record) when done.

You need: a VPS (Ubuntu 24.04 assumed below) with a public IP, a DNS name pointing at it (`hub.example.com` below), two GitHub accounts (the owner, called `OWNER` below, and a second one, `ALICE`), and two computers or two user profiles with `gh` signed in as each account.

## A. On the VPS (as root)

1. Node 24, Caddy, sqlite3:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs sqlite3 git
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
node -v   # v24.x
```

2. A service user and the code (branch `feat/hub-integration`):

```bash
useradd --system --home /opt/mergeport --shell /usr/sbin/nologin mergeport
git clone -b feat/hub-integration https://github.com/KewaiiGamer/mergeport /opt/mergeport
chown -R mergeport:mergeport /opt/mergeport
sudo -u mergeport bash -c 'cd /opt/mergeport && npm ci'
mkdir -p /var/lib/mergeport-hub && chown mergeport:mergeport /var/lib/mergeport-hub
```

3. GitHub OAuth App, on github.com as `OWNER`: Settings → Developer settings → OAuth Apps → New OAuth App. Homepage URL `https://hub.example.com`, tick **Enable Device Flow**, callback URL can be the homepage URL. Copy the Client ID; generate and copy a Client secret.

4. Environment file `/etc/mergeport-hub.env` (mode 600):

```
MERGEPORT_HUB_DATA=/var/lib/mergeport-hub
MERGEPORT_HUB_PUBLIC_URL=https://hub.example.com
MERGEPORT_HUB_GITHUB_CLIENT_ID=<client id>
MERGEPORT_HUB_GITHUB_CLIENT_SECRET=<client secret>
MERGEPORT_HUB_OWNER_LOGIN=<OWNER's GitHub login>
MERGEPORT_HUB_PORT=8787
MERGEPORT_HUB_TRUST_PROXY=true
```

```bash
chmod 600 /etc/mergeport-hub.env && chown root:mergeport /etc/mergeport-hub.env && chmod 640 /etc/mergeport-hub.env
```

5. systemd unit `/etc/systemd/system/mergeport-hub.service`:

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

```bash
systemctl daemon-reload && systemctl enable --now mergeport-hub && systemctl status mergeport-hub --no-pager
journalctl -u mergeport-hub -n 20 --no-pager
```

Expected in the log: the hub listening on `127.0.0.1:8787` and nothing about missing configuration.

6. Caddy, `/etc/caddy/Caddyfile`:

```
hub.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

```bash
systemctl reload caddy
curl -s https://hub.example.com/health
```

Expected: `{"ok":true,"team":null,"schema":1,"publicUrl":"https://hub.example.com","githubHost":"github.com","bootstrapped":false}`. Ports 80 and 443 must be open in the VPS firewall; 8787 must not be.

## B. On OWNER's computer

1. Branch `feat/hub-integration`, `npm ci`, `gh auth status` showing `OWNER`.
2. `npm run local`. The sign-in page shows two cards. Choose **Connect to a server**, enter `https://hub.example.com`.
   - Expected: the page shows the team as not yet created, then a user code and an **Open GitHub** button.
3. Open GitHub, enter the code, authorize the OAuth App (scope `read:user` only).
   - Expected: the app switches to the hub workspace ("Switching workspace…", a few seconds), then opens signed in. `curl https://hub.example.com/health` now reports `bootstrapped: true` and `team: {"name":"<OWNER>'s team"}`.
4. **Team** page: you are OWNER, connection pill **Live**, one member. Invite `ALICE` by username as Member.
5. Create a project and a few cards on the planning board; create a task and assign it to `ALICE`.

## C. On ALICE's computer

1. Same branch, `npm ci`, `gh` signed in as `ALICE`.
2. `npm run local` → **Connect to a server** → `https://hub.example.com` → device flow.
   - Expected: admitted as Member. If you try this before step B.4, expected: "not invited" refusal.
3. Expected within 2 s of opening: OWNER's project, cards and the assigned task are present; **My attention** lists the task.

## D. Live sync checks (both computers open, Team page pill Live on both)

| # | Action | Expected |
| --- | --- | --- |
| 1 | OWNER moves a card to another column | ALICE sees it move within about 1 s, no refresh |
| 2 | ALICE comments on the task | OWNER sees the comment within about 1 s |
| 3 | Both edit different cards at the same moment | Both edits land on both sides; Sync page shows no conflict |
| 4 | Both rename the same card at the same moment | One side gets a conflict on the Sync page with both values; choosing mine/theirs settles it on both sides |
| 5 | ALICE: disconnect network, edit two cards, reconnect | Pill goes Reconnecting/Offline then Live; the two edits arrive at OWNER after reconnect; Sync page pending count returns to 0 |
| 6 | OWNER switches to **GitHub (repositories)** in the Workspace switcher, then back | Each switch takes a few seconds; the hub workspace comes back with its data; GitHub workspace has none of it |
| 7 | OWNER creates a restricted space with only OWNER as member and shares a project into it | ALICE never sees that project; `GET /spaces/<id>/snapshot` with ALICE's session returns 404 |
| 8 | OWNER removes ALICE on the Team page | ALICE's pill shows removed/offline within seconds; hub data disappears from ALICE's app; her unsent edits, if any, are listed as quarantined on the Sync page; ALICE's device sign-in is refused as removed |
| 9 | OWNER reinstates ALICE (owner-only action on the Team page) and ALICE signs in again | ALICE is back as the chosen role with the common space only |
| 10 | On the VPS: `systemctl restart mergeport-hub` while both apps are open | Both pills go Reconnecting then Live within about 30 s; an edit made during the restart arrives after it |
| 11 | On the VPS: restore an older backup (`systemctl stop mergeport-hub; cp hub-<date>.db hub.db; systemctl start mergeport-hub`) | Clients detect the restore: Sync page shows what was replaced; unsent edits are kept, nothing silently diverges |

## E. What to look at on the VPS

```bash
journalctl -u mergeport-hub -f
```

Lines are `method path status ms member=<id>`. Expected never to appear: a session token, a GitHub token, a device or user code, entity data.

```bash
cd /var/lib/mergeport-hub && sqlite3 hub.db "select github_id, login, role, status from member;"
sqlite3 hub.db ".backup hub-$(date +%F).db"
```

## Known gaps in this branch

- Based on an older `main`; merging current upstream `main` conflicts in `prisma/schema.prisma`, `scripts/start-local.ts`, `src/app/(app)/layout.tsx`, `src/components/shell/Topbar.tsx`.
- The hub session key file lives beside the profile database (see `docs/architecture.md`).
