# Features

## Multi-Server Sync

Streamio can merge user-library data (watchlist, favorites, ratings, watch history, follows)
across several independently hosted Streamio instances ("hosting points"), so the same account
stays up to date no matter which server the user is on.

- Pull-based and bidirectional: each server periodically pulls changes from every enabled peer
  and merges them into its own database. It never pushes to peers — they pull on their own
  schedule.
- Users are matched across servers **by email only**. If no local user has a peer's email, that
  row is skipped — sync never creates new accounts, it only merges into existing ones.
- Additive-only: deletions do not propagate between servers.

Hosting points and the sync schedule are managed under `/api/settings`, which is restricted to
admins (see `ADMIN_EMAILS` in [Configuration](configuration.md)).

Implementation: `services/sync.service.ts` and `services/settings.service.ts`; the pull endpoint
peers call is `sync.router.ts` (`GET /api/sync/export`), gated by a shared-secret check rather
than user auth. See [Architecture](architecture.md#services-layer-servicesservicets).

## Chromecast

Casting uses a custom Cast Application Framework (CAF) receiver instead of the default media
receiver, because Streamio's HLS streams (demuxed audio/video renditions) aren't handled correctly
by the default one.

**The receiver lives in its own repository, [cast-receiver][receiver-repo], and is deployed as a
static page.** Google Cast pins an application id to one fixed receiver URL, so it could not be
per-install anyway — and the receiver is told which backend to talk to per cast, in
`customData.apiBase`, so a single deployment serves every install.

If `CAST_RECEIVER_APP_ID` is left unset, Streamio uses the app id of that shared deployment, and
casting works out of the box. Set it only if you want to run your own receiver: register a Custom
Receiver in the [Google Cast SDK Developer Console](https://cast.google.com/publish) pointing at
your own deployment of that repo, then put its Application ID in your `.env`:

```
CAST_RECEIVER_APP_ID=<your app id>
```

Both senders read it from the server at runtime via `GET /api/cast-config`, so no client release
is needed. See the receiver repo's README for the console walkthrough and the test-device
registration you need while iterating.

**`APP_URL` must be reachable over https.** The receiver is served over https, so an `apiBase` on
plain `http://` is blocked as mixed content: playback still starts, but autoplay-next,
re-resolution and remote logging all go dark. A Cloudflare Tunnel or any TLS-terminating reverse
proxy in front of the install is https, so a normal install is fine.

[receiver-repo]: https://github.com/jaupi-enrico/cast-receiver

Playback is also routed through `/api/cast-proxy` for any resolved stream carrying `headers` — see
[Architecture § Frontend](architecture.md#frontend-public) for why.

### What the receiver does

The receiver draws its own UI (idle / loading / playing / paused / up-next / error) on an overlay
above `<cast-media-player>`, and does more than play a URL:

- **Auto-plays the next episode by itself.** It resolves servers and the stream URL against the
  public API rather than replaying a queue the sender pushed — resolved stream URLs expire in
  minutes, so pre-resolved queue items would be dead on arrival, and doing it receiver-side means
  autoplay keeps working after the browser tab that started the cast is closed.
- **Re-resolves an expired or broken stream** (errors 905/315/network) up to three times, rotating
  the server each attempt, and resumes at the same second.
- **Renders sideloaded subtitles**, restyled via `TextTrackStyle`. Their URLs go through
  `/api/cast-proxy` — upstream VTT is often plain `http` and never carries a CORS header, either
  of which makes CAF drop the track silently.
- **Keeps `MediaInformation.metadata` populated** even though the DOM draws the UI, because that
  is what Google Assistant and the phone's media notification read.

The browser page becomes a remote while casting: `#castPanel` (the cast button toggles it) gives
play/pause, seek, volume, episode switching and disconnect, and reports playback position to watch
history every 30s. History only advances while that page is open — the receiver has no access
token and cannot write it itself. Watch-party sync stands down for the duration of a cast session.

### The `customData` contract

The sender attaches a `customData` object to every `LOAD`. **This is a cross-client interface** —
the Flutter app is the other sender, and the receiver is a third repo — so every field is optional
and the receiver degrades field by field rather than requiring a coordinated release. Adding a
field is safe; removing or renaming one is not.

The canonical description of the contract, the `urn:x-cast:com.streamio.control` message list and
the API surface the receiver calls on its own lives with the receiver, in
[`docs/protocol.md`][receiver-protocol] — it is the one implementation both senders must satisfy.

This repo's half is `buildCastCustomData()` in `public/scripts/watch.js`, which attaches
provider/show/episode ids, artwork, subtitles and the episode list (`{id,s,e,t}`) to every LOAD,
plus `apiBase` and `castProxyBase` (from `GET /api/cast-config`) telling the receiver which
install to talk to. `castProxyBase` must equal `CAST_PROXY_PREFIX` in `routes/content.router.ts`
character for character: the receiver has no page origin, so a mismatch means the master manifest
loads and every segment 404s.

Both sides treat every message as advisory: a device may be running an older receiver out of its
cache.

[receiver-protocol]: https://github.com/jaupi-enrico/cast-receiver/blob/main/docs/protocol.md

### `APP_URL` must not redirect

Whatever `APP_URL` points at has to answer `/api/*` **directly**, with no redirect. It is what
`CAST_PROXY_PREFIX` is built from and what the sender hands the receiver as `apiBase`, so it is
the base for the manifest, every rendition, every segment, and the receiver's own API calls. If a
reverse proxy in front of the install redirects `/api/*` instead of proxying it, casting fails
with an instant **905** (CAF won't follow a cross-origin redirect for a master manifest) and
receiver-side episode resolution fails silently (a redirected POST is not replayed as a POST). A
quick-tunnel URL that changes on every restart is never a valid `APP_URL` either.

The receiver logs its environment and every state transition to `GET /api/cast-log`, which prints
`[CAST-RECEIVER]` lines in the `streamio` container — the only practical way to debug a TV.
Known-good CAF build is logged as `[R][env] caf=…` at boot; the `v3` gstatic URL is a rolling
channel, so record what worked if you ever need to bisect.

## Auto-Shutdown / Power Control

Streamio can track its own idle time and request that the host machine be powered off after N
minutes of no activity — useful if you're running it on hardware you'd rather not leave on 24/7.

Because the app runs inside Docker, it can't power off its own host directly. Instead:

- The app tracks activity and exposes `GET /internal/power/status` (shared-secret gated), saying
  whether a shutdown should happen and why (`idle` or `manual`).
- A separate process, **[`power-controller/`](../power-controller/README.md)**, runs directly on
  the host (not in Docker), polls that endpoint, and is the only thing that actually runs the
  poweroff command. It supports Linux/Windows/macOS and a `DRY_RUN` mode for safe testing.
- Optionally, **[`login-checker/`](../login-checker/README.md)** runs only while a desktop
  session is logged in, so `power-controller` can skip an idle-triggered shutdown while someone
  is physically using the machine (manual/admin-triggered shutdowns are never gated by this).

Admins configure the enabled state, idle threshold, and minimum uptime (so a Wake-on-LAN boot
isn't shut back down instantly) under `/api/settings/power`. See the linked READMEs for full
setup instructions, and `POWER_CONTROLLER_SECRET` in [Configuration](configuration.md).

## Watch parties (rooms)

Lets a group of logged-in users watch the same title in sync. See
[Architecture § Watch parties (rooms)](architecture.md#watch-parties-rooms) for the full design
(REST membership model, the idle-room reaper, and the WebSocket realtime layer).

## Skip Intro / Recap / Credits / Preview

The watch page overlays a "Skip" button, matching the existing "Play next episode" prompt in look
and interaction, whenever [TheIntroDB](https://theintrodb.org) has timestamps for the segment the
playhead is currently in. All four of TheIntroDB's segment kinds are handled — intro, recap,
credits, and preview — each with its own button label, and a segment whose end "runs to the end of
media" (a common shape for credits/preview) behaves like the next-episode action instead of just
seeking to the last frame.

TheIntroDB is keyed by TMDB/TVDB/IMDB id. A local title only has one when its `imdb_id` was filled
in — by hand, or via the admin "fill in from a TMDB id" flow
(`services/tmdb-import.service.ts`) — so a title with neither an id nor one on file just never
shows the button; there's no title-matching fallback for a source that isn't scraped from
anywhere. This feature is always best-effort and can never block or break playback.

Implementation:

- `services/intro-db.service.ts` — wraps the official [`theintrodb`][theintrodb-npm] client
  (native id lookup, Redis caching, self-throttling under TheIntroDB's rate limit, and fail-silent
  error handling).
- `GET /api/intro-segments` in `routes/content.router.ts` — provider-agnostic; it never dispatches
  through `Core` and isn't gated by the adult-content check, since it's pure third-party metadata,
  not provider content.
- `public/scripts/watch.js` (`loadIntroSegments`/`maybeShowSkipSegment`) and the
  `#skipSegmentPrompt` overlay in `public/watch.html`/`watch.css`.

An optional `THEINTRODB_API_KEY` (see [Configuration](configuration.md#streaming)) prioritizes
your own submissions in TheIntroDB's averaging; anonymous reads work fine without one.

**Casting.** The Chromecast receiver (`cast-receiver`, a separate repo) renders its own Skip
button and fetches `/api/intro-segments` itself — the same "resolve it receiver-side" approach it
already uses for the episode queue, so the button keeps working for an episode the receiver
advanced to on its own after this tab (or the Flutter app) is closed. `buildCastCustomData()`
hands over `tmdbId`/`imdbId`/`year` as hints (reusing whatever `loadIntroSegments()` already
resolved for the local button), but they're optional — the receiver derives `tmdbId` from `showId`
itself when absent and otherwise falls back to the same title-only fuzzy match. The web cast panel
(`#castSkipSegmentBtn`) and the Flutter app's `CastControlPanel` both also show a Skip button,
driven by the receiver's `STATE.skipSegment` and sending `SKIP_SEGMENT_NOW` — see
`docs/protocol.md` §5 in the receiver's repo for the full contract, including the physical TV
remote (D-pad OK/Back/Left/Right) support that button also needs.

[theintrodb-npm]: https://www.npmjs.com/package/theintrodb

## Account stats and badges

Every account accumulates a set of viewing statistics, and earns badges as those numbers cross
thresholds. Both live under **Account → Stats**, and both are **private**: `GET
/api/account/stats` and `GET /api/account/badges` sit on the `requireAuth` account router and read
the user id from the token, so there is no shape of either URL that returns someone else's
numbers. Nothing is surfaced on a public profile or in the social feed.

### The stats

| Stat | Source |
| --- | --- |
| Watch time | Accumulated counter (`user_stats.total_watch_seconds`) |
| Episodes finished / movies finished / still watching | `watch_history` |
| Shows finished | `watch_history` — shows with no unfinished episode |
| Titles started | Distinct `(provider, show_id)` in history |
| Current streak / longest streak / active days | `user_watch_days` |
| Watchlist, favorites, titles rated, average rating | `watchlist`, `favorites`, `ratings` |
| Providers used, most-watched provider | `watch_history` |
| Followers, following, shares sent/received, reactions received | `follows`, `shares`, `share_reactions` |
| Member since, first/last watched | `users`, `watch_history` |

Two of those can't be derived from the existing tables, because `watch_history` keeps **one
upserted row per title/episode** rather than an event log:

- **Watch time.** A row remembers only the furthest point reached, so a rewatch — or watching the
  same episode twice — adds nothing to a `SUM`. The counter accumulates the *delta* of each
  progress report instead, clamped to 4h per report so a client reporting a garbage duration (or a
  seek to the end of a 12-hour "episode") can't mint hours out of nothing.
- **Which days were watched on.** A row carries one `watched_at`, overwritten on every later
  report, so a day's activity vanishes the moment the same episode is touched again. `user_watch_days`
  keeps the day set separately, which is what makes real streaks possible.

Both are written by the same statement that records watch progress
(`AccountService.upsertWatchProgress`), so they can't drift from it, and both deliberately survive
*Clear history* — deleting the record of *what* was watched shouldn't retroactively un-earn the
time spent watching it.

"Shows finished" means **every episode in your history for that show is completed**, not "watched
all episodes that exist". The true episode count lives upstream: learning it would cost a provider
fetch per show, and for a running series it changes under you.

### The badges

The catalogue lives in `services/badges.catalog.ts` — 30-odd badges in nine categories (watch time,
episodes, movies, shows, streaks, library, ratings, social, discovery), each a slug, an icon, a
stat and a threshold. It is code rather than a table on purpose: a badge is a name, an icon and a
number, all three get reworded, and none is worth a migration.

- Adding a badge awards it retroactively, on the owner's next stats read, to everyone whose
  numbers already clear it. **Renaming a slug is not backwards compatible** — it orphans every row
  already earned under the old one. Reword the label, keep the slug.
- A badge is awarded the first time its threshold is crossed and **never revoked**: `earned_at` is
  a fact about the past, so clearing your history or losing a follower doesn't take a badge back.
- Awarding happens on the stats read itself (`StatsService.syncBadges`), which is why that endpoint
  isn't cached — someone who just crossed a threshold should see the badge on the page that made
  them cross it.

Implementation: `database/migrations/003_stats_badges.sql` (`user_stats`, `user_watch_days`,
`user_badges`), `services/stats.service.ts`, `services/badges.catalog.ts`, the two routes in
`routes/account.router.ts`, and the Stats tab in `public/account.html` /
`public/scripts/account.js` / `public/styles/account.css`.
