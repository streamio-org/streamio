# Configuration

Create a `.env` file (`cp .env.example .env`) and fill in the values below. See
`.env.example` in the repo root for the full list with defaults.

## Streaming

| Variable | Description |
|----------|-------------|
| `TMDB_API_KEY` | Used by the admin "fill in from a TMDB id" flow when adding a local title (`services/tmdb-import.service.ts`) — metadata enrichment for your own library, not a streaming source |
| `THEINTRODB_API_KEY` | **Optional.** Powers the watch page's "Skip Intro/Recap/Credits/Preview" button ([theintrodb.org](https://theintrodb.org)). Anonymous reads work without a key; set one only to prioritize your own submissions in their averaging. |

## Application

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | production/development |
| `APP_URL` | Public base URL this server is reachable on (OAuth redirects, email links, Chromecast proxy base). Include any reverse-proxy path prefix, no trailing slash. **For Chromecast it must be https** — the receiver page is https, so an http base is blocked as mixed content |
| `APP_NAME` | Application name |
| `RESEND_API_KEY` | API key for email sending |
| `ALLOW_PRIVATE_UPSTREAM` | **Optional, `1` to enable.** Lets `/api/cast-proxy` and video resolution fetch private/loopback addresses. Off by default: those endpoints take an absolute URL from the caller, so without the block they proxy anything the container can reach that the internet cannot (cloud metadata on `169.254.169.254`, the `db`/`redis` containers, localhost). Turn it on only to play a source on your own LAN, and only on an install that isn't publicly reachable. Only the *address* check is lifted: the http(s)-only rule, the single-resolution rule (which is what stops DNS rebinding) and the redirect chase stay on |

## Authentication

Generate JWT secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

| Variable |
|----------|
| `JWT_ACCESS_SECRET` |
| `JWT_REFRESH_SECRET` |

## Google OAuth

Create an OAuth application in Google Cloud.

Redirect URI:

```
http://localhost:8080/api/auth/google/callback
```

Variables:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

## Discord OAuth

Create an application in the Discord Developer Portal.

Redirect URI:

```
http://localhost:8080/api/auth/discord/callback
```

Variables:

```
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
```

## Admin / Multi-Server Sync

Comma-separated list of user emails allowed to manage `/api/settings` (hosting points, sync
on/off, sync interval). See [Multi-Server Sync](features.md#multi-server-sync).

```
ADMIN_EMAILS=
```

**The account must have verified its email before it counts as an admin.** Registration accepts
any address and issues a session immediately, so without that requirement anyone could register
*as* a listed address on an install where the admin hadn't signed up yet and be handed admin on
the spot. Sign up, click the link in the verification mail (or sign in with Google/Discord on that
address, which proves the same thing), and the settings routes open up.

On an install that predates this rule, an existing admin account may never have been verified —
the settings routes then start answering 403, and the server log says which address and why. Any
of these fixes it:

- `POST /api/auth/verify-email/resend` with that email, then click the link. With no mail
  transport configured the link and raw token are printed to the server log
  (`docker compose logs streamio`) — `verify-email.html` accepts the token pasted in.
- Sign in with Google or Discord on the same address.
- Set it directly, if you already know the address is yours:
  `docker exec -i streamio-db psql -U postgres -d streamio -c "UPDATE users SET email_verified = TRUE WHERE email = 'you@example.com';"`

## Power Controller / Auto-Shutdown

Shared secret the host-side `power-controller` (see
[Auto-Shutdown / Power Control](features.md#auto-shutdown--power-control)) must send as
`X-Power-Secret` when polling `GET /internal/power/status`. Leave unset to disable the endpoint
(the feature is opt-in).

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
POWER_CONTROLLER_SECRET=
```

## Chromecast

Optional. Unset uses the shared receiver deployment
([cast-receiver](https://github.com/jaupi-enrico/cast-receiver)); set it only to
point at your own. See [Chromecast](features.md#chromecast).

```
CAST_RECEIVER_APP_ID=
```

## Versioning & Updates

See [Versioning & Updates § Configuration](versioning-and-updates.md#configuration) for the full
reference (server-side and updater-side variables, plus the admin API).

| Variable | Purpose |
|---|---|
| `UPDATE_CONTROLLER_SECRET` | Shared secret the updater sends as `X-Update-Secret`. Must match `updater/.env`. |
| `UPDATE_REPO` | `owner/name` releases are published to. A default only — the admin API overrides it. |
| `UPDATE_GITHUB_TOKEN` | **Required for a private repo.** Needs `Contents: read`. |
| `CLIENT_LATEST_VERSION` | Fallback for `/api/version`'s `latest`. |
| `CLIENT_MIN_VERSION` | Fallback for `minSupported`. |
| `CLIENT_DOWNLOAD_URL` | Where a too-old client should go. |
