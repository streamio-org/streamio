# login-checker

Presence beacon for `power-controller`'s auto-shutdown feature.

`power-controller` shuts the machine down after it's been idle for a while — but "idle" as seen by
the Streamio app (no HTTP requests) doesn't know whether someone is sitting at the physical machine
doing something that isn't Streamio. This tiny service closes that gap: it's a localhost-only HTTP
endpoint that's only running while an OS user session is open. Its mere reachability *is* the
signal — no session, no process, no answer.

- Start it **on login** (desktop session start), stop it **on logout** (session end).
- `power-controller` pings it before acting on an `idle`-reason shutdown; if it answers, the
  auto-shutdown is skipped for that poll. It does **not** gate a `manual`/admin-triggered shutdown
  — that's an explicit decision and always goes through.
- It listens on `127.0.0.1` only and requires a shared-secret header (`X-auth`), so nothing on the
  LAN can spoof "someone is logged in".

## Setup

```bash
cd login-checker
npm install
cp .env.example .env   # set LOGIN_TOKEN to a random value
npm run build
```

`LOGIN_TOKEN` must match `LOGIN_CHECK_TOKEN` in `power-controller/.env`.

## Tying it to login/logout

Unlike `power-controller` (which should run continuously across the whole uptime), this process
must be scoped to the desktop session — start when you log in, stop when you log out.

### Linux (systemd --user)

A user unit tied to `graphical-session.target` starts on login and is killed automatically when the
session ends:

```ini
# ~/.config/systemd/user/login-checker.service
[Unit]
Description=Streamio login-checker
PartOf=graphical-session.target

[Service]
Type=simple
WorkingDirectory=/path/to/web/login-checker
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=graphical-session.target
```

```bash
systemctl --user enable --now login-checker
```

**This only works if your compositor actually starts/stops `graphical-session.target`.** GNOME
and KDE Plasma do this themselves; many minimal Wayland compositors (Hyprland, sway, etc.) do
**not** when launched directly — `graphical-session.target` then never activates, so
`login-checker` never starts even though you're logged in, and `power-controller` will
silently treat every idle-shutdown check as "nobody's home" and power the box off from under
you. If you use Hyprland, log in through the `uwsm`-managed session (SDDM lists it as
"Hyprland (uwsm-managed)"; installs `uwsm`) instead of launching Hyprland directly — `uwsm`
explicitly starts the target when the compositor launches and stops it when the compositor
exits, so this keeps working correctly even if your user has `loginctl enable-linger` on (which
would otherwise keep your systemd --user instance, and anything not tied to an explicit
start/stop like this, running regardless of login state). Verify with:
`systemctl --user is-active graphical-session.target` while logged in — if that prints
`inactive`, `login-checker` isn't going to start either.

### Windows (Task Scheduler)

Create a scheduled task triggered "At log on" (for your specific user, not "any user"), action
`node dist\index.js` from the `login-checker` folder. Leave "Run whether user is logged on or not"
**unchecked** — this must only run during an active logged-in session. Task Scheduler stops the
process automatically at logoff if the task isn't set to run in the background.

### macOS (launchd LaunchAgent)

A per-user `LaunchAgent` (not `LaunchDaemon`) only runs while that user is logged in, and is torn
down on logout:

```xml
<!-- ~/Library/LaunchAgents/com.streamio.login-checker.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.streamio.login-checker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/web/login-checker/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/web/login-checker</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.streamio.login-checker.plist
```

## Configuring power-controller to use it

In `power-controller/.env`, set `LOGIN_CHECK_URL` (default `http://127.0.0.1:3001`) and
`LOGIN_CHECK_TOKEN` (must match this service's `LOGIN_TOKEN`). If `LOGIN_CHECK_TOKEN` is left
unset, `power-controller` skips the presence check entirely and idle auto-shutdown behaves as
before this service existed.
