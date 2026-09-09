# power-controller

Host-side watcher for Streamio's auto-shutdown feature.

Streamio's main app runs inside Docker (`restart: unless-stopped`), so it has no way to power off
the physical machine it runs on — stopping its own container wouldn't save any power, and
Wake-on-LAN wakes the *host*, not a container. This is the other half of that feature: a small
process that runs **directly on the host** (not in Docker) and polls the app for a shutdown
request, then actually runs the platform-appropriate poweroff command.

- The app never gets host/power privileges — it only exposes `GET /internal/power/status`
  (secret-gated) saying whether it should be shut down and why (`idle` or `manual`).
- This controller is the only thing that ever calls `poweroff`/`shutdown`.

## Setup

```bash
cd power-controller
npm install
cp .env.example .env   # fill in STREAMIO_URL and POWER_CONTROLLER_SECRET
npm run build
npm start
```

`POWER_CONTROLLER_SECRET` must match the same env var set on the main Streamio app — that's what
authenticates the status poll (`X-Power-Secret` header).

Test safely first with `DRY_RUN=true` in `.env`: it logs what it would do without powering
anything off.

### Pausing auto-shutdown while someone is logged in

Optionally, set up [`../login-checker`](../login-checker/README.md) — a tiny service that runs
only for the duration of a desktop login session. If `LOGIN_CHECK_TOKEN` is set here (matching that
service's `LOGIN_TOKEN`), this controller pings it before acting on an idle-triggered shutdown; if
someone is logged in, the shutdown is skipped for that poll. Manual/admin-triggered shutdown
(`reason: "manual"`) is never gated by this — it's an explicit decision and always goes through.

## Running it continuously

This process needs to keep running on the host across reboots (including after a WOL wake-up).
Pick whatever fits your OS:

### Linux (systemd)

```ini
# /etc/systemd/system/streamio-power-controller.service
[Unit]
Description=Streamio power-controller
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/web/power-controller
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
User=youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now streamio-power-controller
```

`systemctl poweroff` (what this controller runs) needs no special privilege beyond what an
interactive user session on most distros already has via polkit; if it fails with a permission
error, run the service as `root` or grant the `User` a polkit rule for
`org.freedesktop.login1.power-off`.

### Windows (Task Scheduler)

Create a scheduled task that runs `node dist\index.js` from the `power-controller` folder, trigger
"At startup", with "Run whether user is logged on or not". `shutdown /s /t 0` needs no elevation
for the local machine by default.

### macOS (launchd)

```xml
<!-- ~/Library/LaunchAgents/com.streamio.power-controller.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.streamio.power-controller</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/web/power-controller/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/web/power-controller</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.streamio.power-controller.plist
```

`shutdown -h now` on macOS requires root, so either run the agent as root (a `LaunchDaemon` in
`/Library/LaunchDaemons` instead of a per-user `LaunchAgent`), or grant the running user
passwordless sudo for it:

```
# visudo
youruser ALL=(ALL) NOPASSWD: /sbin/shutdown
```

## Configuring the app side

In the main app's admin settings (`/api/settings/power`, admin-only):

- `PUT /api/settings/power` — `{ enabled, idle_minutes, min_uptime_minutes }` to turn on/tune
  auto-shutdown after N minutes of no activity (with a minimum-uptime floor so a fresh WOL boot
  isn't shut back down instantly).
- `POST /api/settings/power/shutdown` — request an immediate manual shutdown; this controller
  picks it up on its next poll.
- `POST /api/settings/power/shutdown/cancel` — cancel a pending manual request.
- `GET /api/settings/power/status` — current idle/uptime state and whether a shutdown is pending.
