# updater

Host-side watcher for Streamio's self-update feature.

Streamio's main app runs inside Docker, so it can't install its own updates — checking out a new
release and rebuilding means replacing the image the app is currently running from. This is the
other half of that feature: a small process that runs **directly on the host** (not in Docker),
polls the app for a pending update, and carries it out.

- The app never gets git or Docker privileges — it only exposes `GET /internal/update/status`
  (secret-gated) saying whether an update should be installed and which release tag to install.
- This updater is the only thing that ever runs `git checkout` / `docker compose build`.

It's the same split as [`../power-controller`](../power-controller/README.md), which is the
established pattern here for "the app decides, the host acts".

## What an update actually does

1. `POST /internal/update/start` — records the attempt and clears the pending flag, so the
   container that replaces the current one can't hand the same update straight back.
2. `git fetch --tags` and check out the release tag the app named.
3. `docker compose build streamio` — the old container keeps serving throughout, so a build
   failure costs zero downtime.
4. `docker compose up -d streamio` — the only point where the app is actually down.
5. Wait for `/health` to report the new version. The new container runs any pending DB migrations
   at boot before it serves traffic, so there's no separate schema step.
6. `POST /internal/update/finish` — recorded in `update_history`.

If any step fails, the previous ref is checked out and rebuilt, and the failure is recorded.

## Setup

```bash
cd updater
npm install
cp .env.example .env   # fill in UPDATE_CONTROLLER_SECRET and REPO_DIR
npm run build
npm start
```

`UPDATE_CONTROLLER_SECRET` must match the same env var set on the main Streamio app — that's what
authenticates the status poll (`X-Update-Secret` header).

Test safely first with `DRY_RUN=true` in `.env`: it logs what it would do without checking
anything out or rebuilding.

The user this runs as needs write access to `REPO_DIR` and permission to talk to the Docker daemon:

- **Linux** — membership of the `docker` group (`sudo usermod -aG docker <user>`, then re-login).
- **Windows / macOS** — Docker Desktop's daemon is reachable by any user in the local `docker-users`
  group (Windows) or simply any user once Docker Desktop is running (macOS); no extra group setup
  is normally needed as long as Docker Desktop itself is signed in and running under that user.

> ⚠️ **It must run as the user that owns `REPO_DIR`.** systemd runs services as root unless told
> otherwise, and git refuses to operate on a repo owned by someone else — updates then fail with
> `fatal: detected dubious ownership in repository` before they even start. That's what `User=` in
> the bundled service file is for; set it to the checkout's owner.

## Enabling updates on the server side

Updates are off by default. As an admin:

```bash
# point the server at the repo releases are published from
curl -X PUT https://<host>/api/settings/update \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  -d '{"enabled": true, "repo": "streamio-org/streamio", "auto_apply": false}'

# check for a new release right now (bypasses the 30-minute cache)
curl -X POST https://<host>/api/settings/update/check -H "Authorization: Bearer <admin token>"

# install it
curl -X POST https://<host>/api/settings/update/apply -H "Authorization: Bearer <admin token>"
```

With `auto_apply: true` the updater installs new releases as soon as it sees them, with no
approval step. `enabled: false` stops the server checking for releases at all.

The version compared against is `package.json`'s, so a release tag only counts as an update if its
semver is higher than the running build's. Tag releases `v0.3.0` (or `0.3.0`) and keep
`package.json` in sync — a tag that doesn't bump the version is never installed.

## Running it continuously

This process needs to keep running on the host across reboots, same as
[`../power-controller`](../power-controller/README.md). Pick whatever fits your OS.

### Linux (systemd)

A systemd unit is included (`streamio-updater.service`) — adjust `WorkingDirectory` and `User`
(must own `REPO_DIR`, see the warning above), then:

```bash
sudo cp streamio-updater.service /etc/systemd/system/
sudo systemctl enable --now streamio-updater
```

### Windows (Task Scheduler)

Create a scheduled task that runs `node dist\index.js` from the `updater` folder, trigger "At
startup", with "Run whether user is logged on or not" — but set the task's "Run as user" to the
account that owns `REPO_DIR` and is signed into Docker Desktop (git and `docker compose` both need
that identity; running as `SYSTEM` hits the same "dubious ownership" failure described above).

### macOS (launchd)

```xml
<!-- ~/Library/LaunchAgents/com.streamio.updater.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.streamio.updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/web/updater/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/web/updater</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.streamio.updater.plist
```

Use a per-user `LaunchAgent` (not a `LaunchDaemon`), since it must run as the user who owns
`REPO_DIR` and is signed into Docker Desktop — a `LaunchDaemon` runs as root by default, which
hits the same git ownership failure.

Note that this updater's own source lives in the tree it checks out, but it runs from `dist/`,
which isn't tracked — updating the app doesn't restart or rebuild the updater. If a release
changes `updater/`, rebuild it by hand and restart the service for your OS (e.g. on Linux:
`npm run build && sudo systemctl restart streamio-updater`).
