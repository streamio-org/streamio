# Architecture

## Layering: routes → services / PlatformHandler → Core → Providers

- **`routes/*.router.ts`** — Express routers, one per concern (`auth`, `account`, `content`,
  `provider`, `public`, `health`, `follow`, `share`, `settings`, `sync`, `room`). Mounted in
  `server.ts` (`WebServer.setupRoutes`). Auth-gated routes use `auth/middleware.ts` (`requireAuth`
  / `optionalAuth` / `requireAdmin`), which reads a Bearer JWT.
  - `follow.router.ts` and `share.router.ts` are both mounted under `/api/social`.
  - `settings.router.ts` (`/api/settings`) is gated by `requireAuth` + `requireAdmin` for the
    whole router — it manages hosting points and sync config, not per-user preferences.
  - `sync.router.ts` (`/api/sync`) exposes the pull endpoint peer servers call (`GET /export`),
    gated by a shared-secret check (`requireHostingPointSecret`), not user auth.
  - `room.router.ts` (`/api/rooms`) — watch-party rooms: create/get/join/leave/close, all
    `requireAuth`. See [Watch parties (rooms)](#watch-parties-rooms) below for the realtime half.
  - `public.router.ts` serves the static frontend pages from `public/*.html` (home, catalog,
    search, providers, details, watch, rooms, account, login, verify-email, reset-password);
    static assets are served via `express.static("public")` in `server.ts`.
- **`PlatformHandler.ts`** (root) — `WebPlatformHandler extends PlatformHandler`
  (`core/models/PlatformHandler.ts`). This is the caching layer: every content-fetch method
  (`getHome`, `search`, `getShowDetails`, `getEpisodes`, `getServers`, `resolveVideo`, ...) wraps
  the equivalent `Core` call in a Redis-backed cache (`withCache`), with per-endpoint TTLs defined
  in `WebPlatformHandler.TTL`. `search` additionally logs queries to Postgres (`search_logs`),
  best-effort (errors swallowed).
- **`core/core.ts`** (`Core`) — the provider registry, two levels deep: a *family* is a source, a
  *variant* is one language of it. A multi-language site would be one class instantiated once per
  language, sharing the class but not the slug. The **variant slug is the wire identity**: what
  clients send as `?provider=`, what items carry as `providerName`, what keys the response cache
  and the DB `provider` columns. Grouping into families is presentation only.
  Only one family is registered in this build: `local` (`core/providers/LocalProvider.ts`), backed
  by this server's own database and disk rather than a scraped site or a third-party API. An empty
  name means the default family's default variant (`local`); an unrecognized one throws
  `UnknownProviderError` → **400**. A provider's `getName()` must equal its variant slug and its
  `getLanguage()` its registered language — both checked at boot.
  A family can be flagged `adult: true` (omitted from `getListOfProviders()` unless asked) — a
  whole-provider 18+ source, distinct from the per-item `adult` flag a title carries (see
  [18+ content](#18-content) below). `LocalProvider`'s family never sets this. `getProviderCatalog()`
  stays flat, one entry per variant, each carrying `family`/`language`/`languages` so a client can
  group and draw a language selector.
  Also owns cross-cutting logic that isn't provider-specific: HLS URL
  normalization/validation (`normalizeHls`, `isValidUrl`) and video resolution — `resolveVideo`
  dispatches on a family's `resolve` hook; there is no generic fallback resolver, so a family
  without one simply doesn't support video resolution.
- **`core/providers/LocalProvider.ts`** — the only registered provider, implementing the
  `Provider` interface (`core/models/Provider.ts`): `getHome`, `search`, `getMovie(s)`,
  `getTvShow(s)`, `getEpisodesBySeason`, `getServers`, `getVideo`. Reads Postgres tables
  `local_titles`/`local_seasons`/`local_episodes`/`local_media_files`, populated by the admin-only
  `/api/admin/local-provider` router and the transcode pipeline behind it — this class only ever
  reads what those have written, no scraping or third-party fetches involved. Wire ids are
  prefixed (`local-movie-<uuid>`, `local-tv-<uuid>`, `local-tv-<uuid>#season-<n>`,
  `local-tv-<uuid>#s<n>e<m>`) so `Core.getShowDetails`'s movie/TV probing (try `getTvShow` before
  `getMovie`) works the same way it would for any id-addressed provider.
  `getServers` answers with an empty list, not an error, for a title/episode whose file hasn't
  finished transcoding — "not ready" and "nothing to play" look the same to a client either way.
  `getVideo` returns this server's own `/api/local-media/<fileId>/master.m3u8` URL: same origin,
  no headers to attach, nothing for `/api/cast-proxy` to do.
- **`core/adapters/AppAdapter.ts`** — normalizes raw provider shapes into the shared domain models
  used across `core/models/`; still the type contract those models are built against even with a
  single provider.
- **`core/utils/`** — `TMDb3.ts`, a plain TMDB v3 API client, backs
  `services/tmdb-import.service.ts`'s admin "fill in from a TMDB id" flow when adding a local
  title. It is metadata enrichment for the local library, not a streaming source — nothing here
  plays video through TMDB.
- **`core/models/*.ts`** — shared domain types (`Movie`, `TvShow`, `Episode`, `Season`, `Category`,
  `Genre`, `People`, `Provider`, `Video`, `WatchItem`, `Show`, `EventHandler`, ...) that providers
  normalize their data into.

Adding a new source means: implement `Provider` in `core/providers/`, and export a `providerFamily`
descriptor from that same file (discovery reads the directory at boot — see the registry's own
comments in `core/providers/registry.ts`), with one variant, a unique `order`, and a `resolve`
hook (there is no generic fallback resolver). Add a cache key/TTL bucket in `WebPlatformHandler`
only if it needs a new endpoint. Adding a *language* to an existing source is a second variant on
that family, not a new class.

## Services layer (`services/*.service.ts`)

Business logic behind the account/social/sync routers, separate from the content pipeline above:

- **`account.service.ts`** — user CRUD, password auth, refresh-token issuance/rotation, email
  verification/password-reset tokens; used by `auth.router.ts` and `account.router.ts`.
- **`follow.service.ts`** — follow/unfollow, follower/following lists, follow counts.
- **`share.service.ts`** — sharing a show/episode/clip with another user (inbox/sent) plus emoji
  reactions on shares (`ALLOWED_REACTIONS`).
- **`settings.service.ts`** — admin-only server config: the `hosting_points` list (peer Streamio
  instances) and sync scheduling settings (enabled/interval).
- **`sync.service.ts`** — syncs user-library data (watchlist, favorites, ratings, watch history,
  follows) between this server and its configured hosting points. See
  [Multi-Server Sync](features.md#multi-server-sync). Started via `SyncService.startScheduler()`
  in `server.ts`.
- **`mail.service.ts`** — transactional email (verification, password reset) via Resend
  (`RESEND_API_KEY`).
- **`room.service.ts`** — watch-party CRUD/membership and shared playback state (Postgres:
  `rooms` + `room_members`), used by `room.router.ts`. `room-socket.service.ts` (`RoomHub`) is
  the realtime counterpart — see [Watch parties (rooms)](#watch-parties-rooms) below.
- **`idle-shutdown.service.ts`** — tracks whether the server looks idle. See
  [Auto-Shutdown / Power Control](features.md#auto-shutdown--power-control).
- **`adult.service.ts`**, **`adult-filter.service.ts`** — the 18+ gate. See
  [18+ content](#18-content) below.

## 18+ content

Gated per user by a single `adult_content` boolean in `user_preferences`, created by hand from
Account → Preferences. Off, absent, or logged out all mean the same thing: no adult content. Only
a JSON `true` opens the gate.

- **`adult.service.ts`** (`AdultService.isAllowed(userId)`) resolves it, Redis-cached 60s under
  `adultpref:adult_content:<userId>`, busted by the preference write/delete handlers in
  `account.router.ts` (`AdultService.invalidate`). Anonymous callers are always refused.
- **Enforcement is server-side**, in `provider.router.ts` and `content.router.ts`, both mounted
  under `optionalAuth` in `server.ts`. The frontend content pages send the token via
  `fetchPublic`/`ensureSessionQuietly` (`public/scripts/auth.js`), which — unlike `apiFetch` —
  never refresh and never redirect to `/login`, since browsing logged out stays valid.
- **The signal is a single per-item flag**: `local_titles.adult`, set by hand by whoever adds the
  title, surfaced as `adult` on `Movie`/`TvShow`. There is no denylist and no whole-provider adult
  family in this build — `Core`/`ProviderFamily` still support a whole-provider `adult: true` flag
  generically (`isAdultProvider()`), but `LocalProvider`'s family never sets it.
- **Individual titles** are filtered from `/home`, `/search` and `/shows/:id` via
  `adult-filter.service.ts` (`isAdultItem`/`filterItems`/`filterCategories`, reading `item.adult`
  as a plain JSON property). `episodes`/`servers`/`video` are not item-filtered — they receive
  only a season or episode id, with no cheap path back to the show.
- **Library rows** (watchlist, favorites, ratings, history) are `{provider, show_id}` only, with
  no `adult` flag to check — `filterAdultRows` in `account.router.ts` is a no-op today; a gated
  title is instead caught client-side when hydrating the row through `GET /api/shows/:id` returns
  403.
- **Filtering runs after the cache**, in the router, so the response cache stays global and
  unfiltered. The helpers work on plain JSON — a cache hit has no class instances.

## Auth

- `auth/jwt.ts` — short-lived (15m) signed access JWTs (`JWT_ACCESS_SECRET`) plus opaque, hashed
  (SHA-256), long-lived (30d) refresh tokens stored in Postgres (`refresh_tokens` table, see
  `database/migrations/init.sql`).
- `auth/oauth.ts` — Google/Discord OAuth flows. An OAuth identity is only ever matched to (or
  created as) a local account when the provider reports the email address **verified** — the
  address is the only thing tying the two together, and Discord lets an account carry an
  arbitrary unconfirmed one, which would otherwise make "sign in with Discord" a way into any
  account whose email you know.
- `auth/password.ts`, `auth/rateLimit.ts` — password hashing (bcrypt) and login rate limiting.
- `auth/middleware.ts` — `requireAuth`/`optionalAuth` Express middleware (expects
  `Authorization: Bearer <token>`), plus `createRequireAdmin(db)`, which gates admin-only routes
  (`settings.router.ts`) against the `ADMIN_EMAILS` env var (comma-separated allowlist). It reads
  the allowlisted address off the **`users` row** and requires `email_verified` — a factory rather
  than a plain middleware for that reason. Trusting the JWT's `email` claim alone meant anyone
  could `POST /api/auth/register` a listed address that hadn't signed up yet and get an admin
  session back in the same response.
- User/account data (users, oauth_accounts, refresh_tokens, watchlist, favorites, ratings, watch
  history, follows, shares, hosting_points, rooms, room_members, ...) lives in Postgres; schema in
  `database/migrations/init.sql`.

## Watch parties (rooms)

Lets a group of logged-in users watch the same title in sync — anyone's play/pause/seek or
episode/server change is mirrored to everyone else in the room.

- **Membership/state (REST, `room.router.ts` + `room.service.ts`)** — `POST /api/rooms` creates a
  room (owner + a short 6-char `code`, e.g. `AB3C9K`); `POST /api/rooms/:code/join` /
  `.../leave`, `GET /api/rooms/:code`, `GET /api/rooms/mine`, `DELETE /api/rooms/:code`
  (owner-only close). The room row itself carries the shared "now playing" state (provider,
  show/episode ref, `playing`, `position_seconds`) — the source of truth a client reads on
  page load / reconnect. If the owner leaves (`RoomService.leaveRoom`), ownership transfers to
  the next-earliest member; if the last member leaves, the room row is deleted directly (not
  just via cascade). Account deletion (`DELETE /api/account/me`) calls
  `RoomService.leaveAllRooms` for the same reason — before the user row is deleted, every room
  they're in is handed off/closed the same way, so a deleted owner's `rooms.owner_id` FK never
  actually needs its `ON DELETE CASCADE` to fire (that constraint is a last-resort safety net,
  not the intended cleanup path — relying on it directly would delete the whole room, including
  for members who are still watching, instead of just transferring ownership).
- **Idle-room reaper (`RoomHub`)** — a room with zero live WebSocket connections for
  `EMPTY_ROOM_GRACE_MS` (2 minutes) is deleted by a 30s sweep (`RoomHub.init`/
  `sweepEmptyRooms`), so a room nobody is actually connected to (tab closed without hitting
  "Leave", or a created room nobody ever opened) doesn't linger forever. `registerActivity`
  (called on REST create/join) and any live socket connecting both reset the per-room clock;
  `init()` also re-seeds the clock for every room already in the DB at boot, since this state is
  in-memory and wouldn't otherwise survive a restart.
- **Realtime sync (WebSocket, `services/room-socket.service.ts` → `RoomHub`)** — clients connect
  to `wss://.../ws/rooms/:code?token=<access_token>` (query param, since the WebSocket
  constructor can't set an `Authorization` header). `server.ts` intercepts the HTTP `Upgrade`
  itself (`http.createServer(this.app)` + a manual `server.on("upgrade", ...)`, not
  `wss({ path })`) so it can verify the JWT and room membership — via `RoomService` — _before_
  accepting the socket, and so `:code` can be a route param. `RoomHub` is an in-memory
  `Map<roomCode, Map<WebSocket, ClientMeta>>` scoped to a single server process — no cross-
  instance pub/sub, fine at the expected scale (a few friends per room). Any member's `state`
  message is persisted via `RoomService.updateState` and rebroadcast to the rest of the room as
  `state_update`; REST join/leave/close call `RoomHub.notifyMembersChanged` /
  `.closeRoom` directly so connected sockets see membership changes made by the REST side too.
- **Client (`public/scripts/room-sync.js`, wired into `watch.js`)** — `RoomConnection` wraps the
  WebSocket with auto-reconnect (exponential backoff). `watch.js` tracks an `applyingRemoteState`
  flag plus a short-lived `roomEchoGuard` so that applying an incoming state update (or the
  room's state on initial join, via the existing deep-link mechanism —
  `deepLinkEpisodeId`/`deepLinkTimeSeconds`) doesn't get re-broadcast back as if it were a new
  local change; every real local play/pause/seek/episode-or-server-change is what actually
  triggers a `state` send. The watch-party UI (code, invite link, member list, start/leave) is
  the slide-in `#roomPanel`, toggled from the `#roomBtn` player control. `details.html` has a
  "Watch Party" button that creates a room for the current title and deep-links into
  `/watch?...&room=<code>`; `/rooms` (`rooms.html`/`rooms.js`) is the join-by-code / "my rooms"
  landing page for someone who only has a code.

## Frontend (`public/`)

Plain static HTML/CSS/JS (no build step, no framework), served directly by `public.router.ts` /
`express.static`. One HTML/CSS/JS trio per page: `home`, `catalog`, `search`, `providers`,
`details`, `watch` (playback via `hls.js`, vendored under `public/scripts/vendor`), `rooms`,
`account`, `login`, `verify-email`, `reset-password`. `public/scripts/auth.js` and `social.js` hold
cross-page auth/social helpers consumed by the page-specific scripts.

`watch.js`'s `playResolvedStream`/`buildPlayableUrl` load `payload.playlistUrl` (the raw HLS URL
from `resolveVideo`) into `hls.js`, routing it through `proxyInsecureSource` first.
`needsSourceProxy` sends a URL through the `/api/cast-proxy` route (`routes/content.router.ts`,
also used for Chromecast) whenever it's plain `http://` on an https page (mixed content) **or**
the resolved payload carries `headers` that only a server-side fetch can attach (forbidden
fetch/XHR header names like Referer/Origin/`sec-fetch-*`). `LocalProvider.getVideo` never attaches
headers — its URL is this server's own origin — so this path exists for any future provider that
needs it. `/api/cast-proxy` fetches server-side with a fixed Referer/UA and rewrites every nested
manifest URI (variant playlists, segments, keys) to stay looped through the proxy, so the whole
playback chain — not just the top-level playlist — avoids the browser's real headers.

### Outbound-URL guard (`core/utils/ssrf.ts`)

`/api/cast-proxy?url=` and the `server` object POSTed to `/api/episodes/:id/video` both name an
absolute URL the server then fetches and relays back, and neither requires authentication. Four
things are enforced, and all four are needed:

1. the scheme is `http(s)` — no `file:`, `gopher:`, `data:`;
2. **every** address the host resolves to is publicly routable — loopback, RFC1918, CGNAT,
   link-local (`169.254.169.254`, the cloud metadata service), multicast and reserved ranges are
   refused, in both their IPv4 and IPv6 spellings (`::ffff:127.0.0.1`, NAT64, 6to4);
3. the same holds after each redirect;
4. the socket connects to *the addresses that were checked*, and to nothing else.

(4) is what makes the first three worth anything. Validating a hostname and then handing the
**name** to `fetch`/axios means the name is resolved a second time, and a record served with
TTL 0 can answer the first lookup with a public address and the second with `127.0.0.1` — DNS
rebinding, repeatable until it lands. So resolution happens exactly once, in `guardedLookup`,
which validates what it resolved and returns those addresses to the socket:

- `safeFetch` fetches through `guardedDispatcher` (an undici `Agent`);
- every guarded axios client spreads `...guardedAgents`.

That is also how (3) is covered for axios, which follows up to 21 redirects with no hook that sees
each hop's URL — but every hop has to open a socket, and every socket comes through the guard. An
IP literal never reaches `lookup` at all (`net.connect` resolves nothing when the host is already
an address), so literals are checked in the agents' `createConnection` instead.

`safeFetch` still chases redirects by hand (`redirect: "manual"`) rather than leaving it to the
built-in follower: it refuses each hop's URL explicitly, and it is what tells `/api/cast-proxy`
which URL actually served the manifest — the base its relative child URIs resolve against
whenever the upstream redirects.

`Core.resolveVideo` repeats checks 1+2 **above** the `family.resolve` branch, for callers that
reach `Core` without going through the router (`tests/providers.test.mjs`). `ALLOW_PRIVATE_UPSTREAM=1`
disables the address check for a LAN-only install; the scheme check, the single-resolution rule
and the redirect chase stay on. `npm run test:ssrf` covers the classifier, the pinning and the
rebinding case.

## Data stores

- **Postgres** (`database/db.ts`, `Database` class) — thin wrapper over `pg.Pool` (`query`/`one`/
  `all`/`close`). Used for user accounts, auth, watchlist/favorites/ratings/history, social
  (follows/shares), search logging, and hosting-points/sync config.
- **Redis** (`database/redis.ts`, `Redis` class) — thin wrapper over the `redis` client
  (`get`/`set`/`del`/`exists`/`increment`). Used as the response cache behind
  `WebPlatformHandler` (JSON-serialized, per-endpoint TTLs) and by the share endpoint's rate
  limiter (`shareLimiter`).

## Cross-cutting invariants (with the `app/` client)

The sibling `app/` directory (a Flutter client of this backend) is a separate repository. These
contracts span both projects; changing one side alone breaks things in ways local tests won't
catch. The client half of each is described in `app/CLAUDE.md`.

- **Version handshake.** The app sends `X-Client-Version` alongside `X-Client: app` and reads
  `GET /api/version` to decide whether to prompt (`updateAvailable`) or block (`updateRequired`).
  Any request can come back **426** with a `client` payload once enforcement is on, at any point in
  the app's lifetime — that status has to be handled globally, not just at startup, and must not be
  treated as an auth failure that clears tokens. Raising `minSupported` locks out every build below
  it immediately, so raise it only once the newer build is actually published at `downloadUrl`.
- **Native auth.** The web frontend keeps its refresh token in an httpOnly cookie, which a native
  client cannot use. The app sends `X-Client: app`, and `sendTokens` in `routes/auth.router.ts`
  then also returns the refresh token in the JSON body and accepts it back in the body on
  `/refresh` and `/logout`. OAuth works the same way via an allowlisted
  `redirect_uri=streamio://auth`. **Browser behavior must stay byte-identical when touching this.**
- **Only a rejected refresh token ends a session.** Refresh tokens rotate on use, so
  `rotateRefreshToken` keeps a 60s grace window in Redis (`rtg:<hash>`): a token it retired that
  recently is still honored, because a client whose response was lost mid-rotation is holding a
  token the server already revoked and would otherwise be signed out for good. A token that is
  genuinely dead is rejected on its own — it must not revoke the user's other sessions, or one
  stale device signs them out everywhere. Both clients mirror the rule: only 401/403 *from
  `/api/auth/refresh` itself* clears stored tokens; a 429 from `refreshLimiter` (keyed per token,
  not per IP, so one NAT isn't one budget), a 5xx, an unfollowed redirect or an offline moment are
  retryable failures that leave the session intact.
- **Redirects.** `dart:io` auto-follows redirects for GET/HEAD only, so the app follows them by hand
  for all methods, preserving method and body — unlike a browser, which downgrades a 302'd POST to
  GET. Keep that in mind before adding a redirect to any write endpoint; a reverse proxy or tunnel
  in front of an install may already redirect by design.
- **Path-prefixed installs.** An install mounted at `https://host/streamio` is supported: the
  reverse proxy strips the prefix (routes are registered at the root), but `APP_URL` must *include*
  it, since `content.router.ts` derives `CAST_PUBLIC_BASE` from it and the Chromecast receiver has
  no page origin to resolve a relative URL against. Get it wrong and the master manifest loads while
  every segment 404s.
- **A resolved stream carrying `headers` must be proxied, whatever its host.** Those headers exist
  because forbidden fetch/XHR header names (Referer/Origin/`sec-fetch-*`) are needed, so only a
  server-side fetch can send them. Both `public/scripts/watch.js` (`needsSourceProxy`) and the app
  route it through `/api/cast-proxy`, which refetches server-side with a fixed Referer/UA and
  rewrites every nested manifest URI.
- **Resolved streams are never cached client-side.** `POST /api/episodes/:id/video` returns signed
  URLs that expire in minutes; clients re-resolve per playback attempt, and a paused app download
  re-resolves before resuming. Don't change these to long-lived URLs without telling both clients.
