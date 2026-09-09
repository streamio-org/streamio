# CLAUDE.md

Guidance for Claude Code in this repo (`web/` — backend + static frontend).

`web/` is the git repo and source of truth. The sibling `app/` (Flutter client) is **outside**
this repo and untracked — `git status` from the parent fails, commits can only contain `web/`
files. `app/CLAUDE.md` documents that client; see "Cross-cutting invariants" below for shared
contracts.

## Project

Streamio — a Node/Express backend + static server-rendered `public/` frontend that serves the
user's own uploaded movies and shows (this build has no scraped/third-party content sources — see
"Layering" below), normalizes them, and resolves playable HLS URLs. Also runs a full account
system: auth, watchlist/favorites/ratings/history, social (follow, share+reactions), and
cross-server sync between independently hosted Streamio instances ("hosting points"). This build
has no bundled reverse-proxy/tunnel component — put your own in front (Caddy, nginx, a
Cloudflare Tunnel you run yourself, ...) if the install needs to be reachable without
port-forwarding.

## Commands

Run from repo root (`web/`) unless noted.

- `npm run build` — compile TS to `dist/` · `npm run watch` — `tsc --watch`
- `npm run dev` — run compiled server via nodemon (build/watch first; runs `dist/index.js`, not source)
- `npm start` — run `dist/index.js` directly · `npm run stop` — kill running `node dist/index.js`
- `npx tsc --noEmit` — type-check only, fastest correctness check
- `npm run test:providers` — smoke test for the `local` provider (`tests/providers.test.mjs`):
  builds, then walks one movie and one show already in the database through
  home→search→details→episodes→servers→resolved stream. Requires `DATABASE_URL` pointed at a
  real, migrated database with at least one ready title — there's no upstream to fixture against,
  since `local` reads its own tables. Flags: `--no-stream`, `--json`.
- `npm run test:genres` — smoke test for `local`'s genre browsing (`tests/genres.test.mjs`), same
  DB requirement. Asserts two different genres return different pages, catching a query that
  accidentally matches everything.
- `npm run test:ssrf` — unit tests for the outbound-URL guard (`tests/ssrf.test.mjs`): which
  addresses count as private in both v4 and v6 spellings, and — against loopback listeners it
  starts itself — that no byte of an internal response comes back through `safeFetch`, through a
  guarded axios client, through a redirect, or through a DNS-rebinding host. Same shape of failure
  as `test:device-login` — a range (or a hop) that quietly fails open logs nothing.

No dev-server hot-reload from TS source; compile before `dev`/`start` pick up changes.

Server start applies pending DB migrations first — no separate migrate command, no running
against a stale schema. `npm run release` (`scripts/release.sh`) bumps/commits/tags/pushes and
publishes a GitHub Release via `gh`; see `docs/UPDATES.md`/`docs/CHEATSHEET.md`.

### Chromecast receiver

The Chromecast CAF receiver is **not in this repo** — lives in `cast-receiver`, deployed as a
static page, told which backend to use per-cast (`customData.apiBase`/`castProxyBase`). One
deployment serves every install. This side keeps: `CAST_RECEIVER_APP_ID`, `CAST_PROXY_PREFIX`/
`/api/cast-proxy`+`/api/cast-log` in `content.router.ts`, and `GET /api/cast-config`.
**`APP_URL` must be https-reachable** — the receiver is https, so `http://` `apiBase` is blocked
as mixed content (loses autoplay-next, re-resolution, remote logging).

**If you put a reverse proxy in front of this app, `/api/*` must be reverse-proxied, never
redirected** — a 302 is fatal for Chromecast (CAF won't chase a cross-origin redirect for an HLS
manifest, error 905), the manifest rewriter stamps this service's public base into every
rendition/segment, and a 302'd POST doesn't survive as a POST.

### `power-controller/` and `login-checker/`

Standalone npm packages, run **on the host**, not Docker — the app can't power off its own
machine. `power-controller/` polls `GET /internal/power/status` and runs the platform poweroff
command. `login-checker/` is an optional localhost-only presence beacon tied to the OS login
session; `power-controller` checks it before an idle-triggered (not manual) shutdown so a
present user isn't shut out. See each subproject's README.

### `updater/`

Also host-side, same reason: the app can decide a release should install but can't rebuild the
image it runs from. Polls `GET /internal/update/status` (`X-Update-Secret`); on trigger: records
the attempt (`POST /internal/update/start`, clears pending flag), `git fetch --tags` + checkout
target tag, `docker compose build streamio`, `up -d`, waits for `/health`, `POST
/internal/update/finish`. Building before stopping keeps downtime to the swap; failure rolls back
and is recorded in `update_history`. See `updater/README.md`.

### Docker

`docker-compose.yml`: `streamio` (this app), `db` (Postgres 18), `redis`. Dockerfile
runs `npm ci && npm run build`, starts `dist/index.js` on 8080, `GIT_SHA`/`BUILD_TIME` baked in
as build args. `db` has **no** `docker-entrypoint-initdb.d` mount — the app migrates itself at boot.

## Architecture

### Layering: routes → services / PlatformHandler → Core → Providers

- **`routes/*.router.ts`** — one Express router per concern (`auth`, `account`, `content`,
  `provider`, `public`, `health`, `follow`, `share`, `settings`, `sync`, `room`), mounted in
  `server.ts`. Auth-gated routes use `auth/middleware.ts` (`requireAuth`/`optionalAuth`/
  `createRequireAdmin(db)`, reads Bearer JWT).
  - `follow.router.ts` + `share.router.ts` mount under `/api/social`.
  - `settings.router.ts` (`/api/settings`) is `requireAuth`+`createRequireAdmin(db)` for the whole
    router — hosting points and sync config, not per-user preferences.
  - `sync.router.ts` (`/api/sync`) exposes the peer pull endpoint (`GET /export`), gated by
    shared-secret (`requireHostingPointSecret`), not user auth.
  - `room.router.ts` (`/api/rooms`) — watch-party create/get/join/leave/close, all `requireAuth`.
  - `public.router.ts` serves static frontend pages (`public/*.html`); static assets via
    `express.static("public")`.
- **`PlatformHandler.ts`** — `WebPlatformHandler extends PlatformHandler`
  (`core/models/PlatformHandler.ts`): the caching layer. Every content method (`getHome`,
  `search`, `getShowDetails`, `getEpisodes`, `getServers`, `resolveVideo`, ...) wraps the
  equivalent `Core` call in Redis (`withCache`), per-endpoint TTLs in `WebPlatformHandler.TTL`.
  `search` also logs queries to Postgres (`search_logs`), best-effort.
- **`core/core.ts`** (`Core`) — provider registry + dispatcher from `providerName` to instance.

  **The registry is discovered, not written out.** `core/providers/registry.ts` reads its own
  directory at boot and imports every module in it; a file that exports a `providerFamily`
  descriptor (`ProviderModule` in `core/models/ProviderRegistry.ts`) is a registered source, a
  file that doesn't is not — which is what would keep a shared helper module out of the registry,
  or let a provider class be implemented but deliberately left unregistered. So a source is
  **one file**: the class and the registry entry describing it live together, next to any
  per-variant config the class needs (`LocalProvider.ts` today). `Core`'s constructor just maps
  the discovered list. Only `local` (`core/providers/LocalProvider.ts`) is registered in this
  build — it serves the user's own uploaded media from this server's own database and disk,
  nothing scraped or fetched from a third party.

  Discovery is a **top-level `await`** in `registry.ts`, deliberately: ESM evaluates that before
  anything importing it, so `Core`'s constructor stays *synchronous*. An async `Core` would
  propagate up through `PlatformHandler` → `WebPlatformHandler` → `WebServer`'s constructor and
  turn every sync `Core` accessor into a promise. Two consequences: nothing in a `create()` may
  read the database (it runs before migrations, same rule as `WebServer`'s constructor), and
  **nothing a provider file imports may import `core.js` back** — that closes a cycle which
  deadlocks the top-level await rather than failing loudly. `core/models/index.ts` no longer
  re-exports `PlatformHandler` for exactly this reason.

  `order` on the descriptor is load-bearing and must be unique (duplicates throw at boot):
  ascending order *is* the catalogue order every client's picker renders, and the lowest one's
  first variant is the default provider. `readdir` order must never decide either. Values are
  spaced by ten. `create(ctx)` returning null leaves the family unregistered — how `local` opts
  out when `Core` was built without a `db` (`core/test.ts`'s ad hoc script, `tests/*.test.mjs`).

  `npm run build` cleans `dist/` first (`prebuild`). Now that the compiled directory listing
  decides what is registered, an orphaned `.js` from a deleted `.ts` is no longer inert — it
  gets imported.

  **Registry is two levels: families and variants**, even with one family registered. A *family*
  is a source; a *variant* is one language of it — a multi-language site would be one class
  instantiated once per language rather than one class per mirror, with anything
  language-specific reading `this.getLanguage()` rather than being copy-pasted per mirror.

  **The variant slug — not the family — is the wire identity**: what a client sends as
  `?provider=`, what lands in `providerName`, what keys the `PlatformHandler` cache, what's stored
  in watchlist/favorites/ratings/history/shares/rooms rows. Family grouping is presentation only.
  `getListOfProviders()` returns every concrete slug, flat.

  Empty name → default family's default variant (`local`). Unrecognized name →
  `UnknownProviderError` → **400** (it used to silently fall back to default, so a wrong-provider
  request got another source's catalogue back under the wrong name). **A provider's `getName()`
  must equal its variant slug**, `getLanguage()` its registered language — both checked in the
  `Core` constructor, throw at boot. `getDefaultProviderName()` exists so nothing reads the slug
  off `getName()` by luck.

  A family can be `adult: true` (omitted from `getListOfProviders()` unless asked) — a
  whole-provider 18+ source, distinct from the per-item `adult` flag a title carries (see "18+
  content" below). `LocalProvider`'s family never sets this; its titles are gated individually.
  Each family carries `displayName`/`description`, each variant `languageLabel`.
  `getProviderCatalog()` returns the filtered list — still one entry per variant — plus
  `family`/`language`/the family's `languages` array, so a client groups by `family` with a
  language selector. `GET /api/providers` sends this as `catalog` (plus bare `providers` names
  for older clients, and `default`). **The label for a provider lives here and nowhere else** —
  Flutter renders whatever the catalog says. (`public/scripts/provider-names.js` keeps its own
  fallback copy since the web frontend, unlike the app, ships with the server and can't fall out
  of step.)

  Also owns cross-cutting logic: HLS URL normalization/validation (`normalizeHls`, `isValidUrl`)
  and video resolution. **`resolveVideo` dispatches on a family capability, not provider name**:
  a family declares a `resolve` hook or video resolution isn't supported for it at all — no
  generic fallback extractor exists. This is a registry capability rather than a chain of
  `if (providerName === "...")` comparisons, which is what let an unwritten branch silently
  resolve through the wrong logic with nothing logged.
- **`core/providers/LocalProvider.ts`** — the only registered provider, implementing `Provider`
  (`core/models/Provider.ts`): `getHome`, `search`, `getMovie(s)`, `getTvShow(s)`,
  `getEpisodesBySeason`, `getServers`, `getVideo`. Backed by Postgres tables `local_titles`/
  `local_seasons`/`local_episodes`/`local_media_files`, populated by the admin-only
  `/api/admin/local-provider` router and the transcode pipeline behind it — this class only ever
  reads what those have written. Wire ids are prefixed (`local-movie-<uuid>`, `local-tv-<uuid>`,
  `local-tv-<uuid>#season-<n>`, `local-tv-<uuid>#s<n>e<m>`) so `Core.getShowDetails`'s
  movie/TV probing works the same way it would for any id-addressed provider. `getServers`
  answers with an empty list rather than an error for a title/episode whose file hasn't finished
  transcoding — "not ready" and "nothing to play" look the same to a client either way.
  `getVideo` returns this server's own `/api/local-media/<fileId>/master.m3u8` URL — same origin,
  no headers to attach, nothing for `/api/cast-proxy` to do.
- **`core/adapters/AppAdapter.ts`** — normalizes raw provider shapes into shared domain models;
  still the type contract `core/models/*.ts` is built against even with one provider.
- **`core/utils/ssrf.ts`** — the guard on every outbound fetch whose URL came from a client:
  `/api/cast-proxy?url=`, the `server` object POSTed to `/api/episodes/:id/video` (checked in
  `content.router.ts`, and again in `Core.resolveVideo` **above** the `family.resolve` branch).
  Enforces http(s) only, **every** resolved address publicly routable (loopback/RFC1918/CGNAT/
  link-local — `169.254.169.254` is the cloud metadata service — multicast/reserved, in both v4
  and v6 spellings), and the same after each redirect. Without it these are unauthenticated
  request-forgery proxies into the compose network.
  **Validating a name and then fetching that name is not a guard** — the fetch resolves it a
  second time, and a record served with TTL 0 can answer the two lookups differently (DNS
  rebinding). So resolution happens exactly once, in `guardedLookup`, which validates what it
  resolved and hands *those addresses* to the socket. Everything that fetches a caller-supplied
  URL goes through it: `safeFetch` via `guardedDispatcher` (undici), every guarded axios client
  via `...guardedAgents`. That is also what covers redirects for axios, which follows up to 21 of
  them with no per-hop hook — but every hop opens a socket. IP literals never reach `lookup`
  (`net.connect` skips it), so they are checked in the agents' `createConnection` instead.
  `safeFetch` still chases redirects by hand so it can report the URL that actually served the
  body, which is what a relative manifest URI resolves against.
  `ALLOW_PRIVATE_UPSTREAM=1` opts a LAN-only install out of the address check.
  `npm run test:ssrf` covers the classifier, the pinning and the rebinding case.
- **`core/utils/`** — `TMDb3.ts` (a plain TMDB v3 API client) backs
  `services/tmdb-import.service.ts`'s admin "fill in from a TMDB id" flow when adding a local
  title — it is metadata enrichment for the local library, not a streaming source; nothing here
  plays video through TMDB.
- **`core/models/*.ts`** — shared domain types (`Movie`, `TvShow`, `Episode`, `Season`,
  `Category`, `Genre`, `People`, `Provider`, `Video`, `WatchItem`, `Show`, `EventHandler`, ...).

  **Extra per-title metadata goes in `ShowDetails`, not new constructor arguments.**
  `Movie`/`TvShow` already take eighteen positional arguments that every provider fills
  positionally, so a nineteenth is one silent mis-assignment away at every call site. `ShowDetails`
  (`core/models/ShowDetails.ts`) is one optional bag — original/alternative titles, status,
  format, studio, broadcast season, external ids and links, audio tracks, popularity counters,
  keywords, logo — assigned to `.details` after construction and carried through `copy()`.
  `Season` carries `overview`/`episodeCount`/`released` the same way. **Every field is optional
  and absence means "this source doesn't publish it", never a default** — a provider must leave a
  key off rather than write a zero, and consumers (`public/scripts/details.js`) drop the row
  rather than print a placeholder. `GET /api/shows/:id` serializes the whole object as-is, so
  adding a field is safe anytime; renaming one is a client-visible change. `LocalProvider.ts`
  does not currently populate `.details` — its metadata (title, overview, poster, banner,
  released, runtime, genres, imdb id) lives entirely in the base `Movie`/`TvShow` fields.

  **A listing item must carry enough to fill a card's meta line.** Home rails, search results and
  genre pages hit the same parsers, so a provider keeps one list mapper (`LocalProvider.toItem`,
  which delegates to `toMovie`/`toTvShow`) rather than a copy per call site — home, search and
  genre browsing all return the same shape.

New source site: implement `Provider` in `core/providers/`, and export a `providerFamily`
descriptor from that same file — `displayName`/`description`, one variant, a unique `order`, and
a `resolve` hook (there is no generic fallback resolver). Nothing else registers it. Add a cache
key/TTL in `WebPlatformHandler` only if you added an endpoint; the existing TTLs are per-endpoint,
not per-provider. **A new language on an existing source is a new variant in that descriptor, not
a new class and not a new file.** Nothing changes in `app/` either way — it reads
`GET /api/providers`.

### Genres

Browsing by genre is a **separate listing from search** — `/api/search?query=` and
`/api/genres/:id` never combine.

- **`GenreCapableProvider`** (`core/models/Provider.ts`): `getGenres()` → `Genre{id,name}`,
  `getGenre(id, page)` → one page of titles. Structural interface so `supportsGenres()` can tell
  "can't do this" from "throws" — `/api/genres` answers `supported:false` instead of 500.
- `LocalProvider` implements it off the `genres` jsonb array already on each row — `getGenres`
  collects the distinct genre names across `local_titles`, `getGenre(id, page)` is a plain
  `WHERE genres @> $1::jsonb` query. Id === name: there's no external genre catalog to key off,
  unlike a scraped site's numeric genre id — an admin free-types genres when adding a title.
- `npm run test:genres` asserts two different genres return different pages, catching a query
  that accidentally matches everything.

### Services layer (`services/*.service.ts`)

- **`account.service.ts`** — user CRUD, password auth, refresh-token issuance/rotation, email
  verification/password-reset tokens.
- **`follow.service.ts`** — follow/unfollow, follower/following lists, counts.
- **`share.service.ts`** — sharing a show/episode/clip (inbox/sent) + emoji reactions
  (`ALLOWED_REACTIONS`).
- **`settings.service.ts`** — admin-only: `hosting_points` list, sync scheduling.
- **`sync.service.ts`** — syncs user-library data between this server and configured hosting
  points. Pull-based, bidirectional, additive-only: periodic pull from every enabled peer, merge
  into own DB, never push. Users matched **by email only** — a peer row is skipped if no local
  user has that email. Deletions don't propagate. Started via `SyncService.startScheduler()`.
- **`mail.service.ts`** — transactional email (verification, reset, welcome); owns templates,
  delivery via `services/mail/` (`MailTransport`): `SMTP_HOST` → `SmtpTransport`, else
  `RESEND_API_KEY` → `ResendTransport`, else `LogTransport` (prints instead of sending). Resend
  alone can't work — it delivers only to the account owner until a sender domain is DNS-verified,
  and a self-hosted install behind an ephemeral tunnel has no domain to verify; SMTP has neither
  restriction. `register()` sends **after** the INSERT, best-effort — mail outage costs neither
  boot nor account creation.
  Link bases resolve *per send* via `services/mail/link-base.ts`, which builds them from
  `appBaseUrl()`. A reverse proxy or tunnel in front of an install can still rotate hostnames
  between send and click, so every token email also prints the raw token;
  `verify-email.html`/`reset-password.html` accept it pasted in.
- **`room.service.ts`** — watch-party CRUD/membership + shared playback state (Postgres:
  `rooms`+`room_members`). `room-socket.service.ts` (`RoomHub`) is the realtime counterpart.
- **`stats.service.ts`** + **`badges.catalog.ts`** — per-account viewing statistics and the badges
  they earn, both **private to the account** (`GET /api/account/stats`/`/badges` on the
  `requireAuth` account router, id read from the token, never surfaced on a public profile). Most
  stats are derived live from the library tables; the two that can't be — lifetime watch time and
  the set of days watched on — are accumulated in `user_stats`/`user_watch_days` by the same
  statement as `upsertWatchProgress`, because `watch_history` upserts one row per title/episode and
  so forgets rewatches and overwrites each day's activity. Both survive *Clear history* on purpose.
  The badge catalogue is code, not a table (a badge is a name, icon and threshold — all content);
  **slugs are permanent**, since a rename orphans every `user_badges` row already earned under the
  old one. Badges are awarded on the stats read and never revoked. See
  [docs/features.md](docs/features.md#account-stats-and-badges).
- **`idle-shutdown.service.ts`** — tracks idle state via Redis last-activity timestamp (updated
  on every request except `ACTIVITY_EXCLUDED_PATHS`), exposes `{shouldShutdown, reason}`. Policy
  only. `routes/power.router.ts` (`/internal/power`, `X-Power-Secret` gated) exposes this to
  host-side `power-controller/`. Admin controls under `/api/settings/power`.
- **`intro-db.service.ts`** — powers the watch page's "Skip Intro/Recap/Credits/Preview" button
  via the official `theintrodb` npm client ([TheIntroDB](https://theintrodb.org)). Needs a native
  TMDB or IMDB id — `local_titles.imdb_id`, filled in by hand or via the admin "fill in from a
  TMDB id" flow (`services/tmdb-import.service.ts`) — and fetches segment timestamps for it,
  Redis-cached. No title-matching fallback: a title with neither an id nor one on file has no
  lookup to make. Self-throttled under TheIntroDB's rate limit, fail-silent throughout (never
  caches a transient failure, never throws into the route) since this must never be able to block
  or break playback. `GET /api/intro-segments` (`routes/content.router.ts`) is provider-agnostic
  and ungated — pure third-party metadata, not provider content. See
  [docs/features.md](docs/features.md#skip-intro--recap--credits--preview).

### Watch parties (rooms)

Group of logged-in users watch a title in sync — play/pause/seek/episode/server changes mirror to
everyone.

- **Membership/state (REST)** — `POST /api/rooms` creates a room (owner + 6-char code, e.g.
  `AB3C9K`); join/leave/get/mine/close (owner-only). The room row carries shared "now playing"
  state, read on load/reconnect. Owner leaving → ownership transfers to next-earliest member;
  last member leaving → room row deleted directly. Account deletion calls
  `RoomService.leaveAllRooms` first, so a deleted owner's FK `ON DELETE CASCADE` is a safety net,
  not the intended cleanup path (direct delete would remove the room for members still watching).
- **Idle-room reaper (`RoomHub`)** — a room with zero live WS connections for 2 minutes
  (`EMPTY_ROOM_GRACE_MS`) is deleted by a 30s sweep. REST create/join and any live socket reset
  the clock; `init()` re-seeds it for every DB room at boot since this state is in-memory.
- **Realtime sync (WS, `room-socket.service.ts` → `RoomHub`)** — clients connect to
  `wss://.../ws/rooms/:code?token=<access_token>` (query param — WS ctor can't set headers).
  `server.ts` intercepts the HTTP `Upgrade` manually (not `wss({path})`) to verify JWT+membership
  before accepting, and so `:code` can be a route param. `RoomHub` is an in-memory
  `Map<roomCode, Map<WebSocket, ClientMeta>>` per process — no cross-instance pub/sub, fine at
  expected scale. `state` messages persist via `RoomService.updateState` and rebroadcast; REST
  join/leave/close call `RoomHub.notifyMembersChanged`/`.closeRoom` directly.
- **Client (`public/scripts/room-sync.js`, wired into `watch.js`)** — `RoomConnection` wraps WS
  with auto-reconnect. `watch.js`'s `applyingRemoteState` flag + `roomEchoGuard` stop an applied
  remote state from re-broadcasting as a new local change. UI is the `#roomPanel` slide-in from
  `#roomBtn`. `details.html`'s "Watch Party" button creates a room and deep-links to
  `/watch?...&room=<code>`; `/rooms` is the join-by-code landing page.

### Frontend (`public/`)

Plain static HTML/CSS/JS, no build step/framework, served via `public.router.ts`/
`express.static`. One HTML/CSS/JS trio per page: `home`, `catalog`, `search`, `providers`,
`details`, `watch` (hls.js, vendored), `rooms`, `account`, `login`, `verify-email`,
`reset-password`, `tv` (TV sign-in phone half). `auth.js`/`social.js` hold cross-page helpers.

`show-meta.js` is the other cross-page helper: **what a title's metadata *is* lives there, only
the markup lives in the pages.** `showMeta()` builds the one-line summary under a card title on
home/catalog/search; `showFacts()` returns the ordered `{label, value}` list the watch page
renders as chips and the details page as table rows. Both read `item.details` (`ShowDetails`).
**Never print a placeholder for missing data** — a field the source didn't publish means the row
is dropped, not filled with `—`; that dash was on nearly every catalogue card because the meta
line only ever looked at `runtime`/`genres`, which no listing sets.

`watch.js`'s `playResolvedStream`/`buildPlayableUrl` load `payload.playlistUrl` into hls.js via
`proxyInsecureSource` first. `needsSourceProxy` routes a URL through `/api/cast-proxy` whenever
it's plain `http://` on an https page (mixed content) or the resolved payload carries `headers`
that only a server-side fetch can attach. `/api/cast-proxy` fetches server-side with a fixed
Referer/UA and rewrites every nested manifest URI to stay looped through the proxy.

Blocks toggled with `el.hidden` need a `[hidden] { display: none }` guard whenever their own
rule sets `display` — a `.thing { display: flex }` outranks the UA's `[hidden]` rule, and the
element stays on screen as an empty box.

The watch page's episode grid is a set of `button.epbtn` elements carrying `data-episode-id` and
an `.epbtn-progress` child. Selection, the watched/in-progress classes, the progress bar,
autoplay-next and the cast payload all address episodes through those, so both the rich
`.epcard` and the dense `.epchip` layouts are built *inside* that button rather than replacing it.

**The grid renders a slice; `currentEpisodesList` stays the whole show.** One Piece is 1100+
episodes, so the nav filters by season/block and by a query, and switches density. Autoplay-next,
room sync and the cast payload all index into the complete list, so **a rendered button must be
found by `episodeButton(id)`, never by position** — `querySelectorAll(".epbtn")[i]` highlights the
wrong episode the moment anything but "Tutti" is selected. Anything that makes an episode current
calls `revealEpisode()` first, so a selection can't land on a button the filter is hiding.

**Anything another account authored goes through `escapeHtml` (`auth.js`) at every `innerHTML`
sink** — display names, avatar URLs, share messages. These pages keep the access token in
`sessionStorage` and set no CSP, so a raw display name in the followers list, people search or
share inbox is a zero-click token steal against whoever *looks* at it. Prefer `textContent`/DOM
construction where there's a choice; `renderHero`'s avatar is built as DOM because its fallback
was an inline `onerror` with a user string interpolated into it.

### Versioning and updates

Three separate things, deliberately not conflated:

- **What build is this** — `version.ts`: semver from `package.json` + git SHA baked in at image
  build time. Nothing reads `.git` at runtime. `GET /health`/`GET /api/version` report it.
  `API_VERSION` is a separate integer for the HTTP contract, bumped only on breaking change.
- **Schema migrations** — `database/migrator.ts` applies `database/migrations/<n>_<name>.sql` in
  order, once each, recorded in `schema_migrations`, run in `index.ts` **before**
  `server.start()` — failure is fatal on purpose. One run holds one pooled connection
  (`db.withClient`, not `db.query`, so advisory lock/unlock land on the same client) — also
  prevents two containers double-applying. Pre-migrator installs get `001` **baselined**, not
  replayed. Migration files are immutable once deployed — edits are checksum-detected and warned
  about, never silently re-run. **DB access at startup belongs in `WebServer.start()`, not the
  constructor**, which runs before migrations.
- **Client version policy** — `GET /api/version` (public) reports build, `api.version`, and
  policy (`latest`/`minSupported`/`downloadUrl`/`notes`, in `app_settings` key `client_version`,
  admin-managed via `PUT /api/settings/client-version`, env vars as first-boot fallback). A client
  sending `X-Client-Version` gets `updateAvailable`/`updateRequired`. When `enforce` is on,
  `auth/clientVersion.ts` rejects `X-Client: app` below `minSupported` with **426** (exempts
  `/api/version`/`/health`). Browsers are never gated.
- **Server self-update** — `services/update.service.ts` (policy only) compares the GitHub repo's
  latest release tag against `BUILD.version`, decides whether to update (admin-triggered via
  `POST /api/settings/update/apply`, Redis flag 30-min TTL, or `autoApply`, off by default). Host-
  side `updater/` does the work; `update_history` records attempts.

### Data stores

- **Postgres** (`database/db.ts`, `Database`) — thin `pg.Pool` wrapper (`query`/`one`/`all`/
  `close`). Accounts, auth, watchlist/favorites/ratings/history, social, search logging,
  hosting-points/sync config.
- **Redis** (`database/redis.ts`, `Redis`) — thin wrapper (`get`/`set`/`del`/`exists`/
  `increment`). Response cache behind `WebPlatformHandler` (JSON, per-endpoint TTLs) + share
  endpoint rate limiter (`shareLimiter`).

### Auth

- `auth/jwt.ts` — short-lived (15m) signed access JWTs (`JWT_ACCESS_SECRET`) + opaque, hashed
  (SHA-256), long-lived (30d) refresh tokens in Postgres (`refresh_tokens`).
- `auth/oauth.ts` — Google/Discord OAuth. **An identity is matched to a local account only when
  the provider reports the email verified** (`email_verified`/`verified`) — the address is the
  entire link between the two, and a Discord account can carry any unconfirmed address its owner
  typed, which made signing in with one a way into any account whose email you knew. `auth/deviceLogin.ts` — TV sign-in device flow
  (user-code generation/normalization, device-code hashing, Redis TTLs — see invariant below).
- `auth/password.ts`/`auth/rateLimit.ts` — bcrypt + login rate limiting.
- `auth/middleware.ts` — `requireAuth`/`optionalAuth` (`Authorization: Bearer`),
  `createRequireAdmin(db)` (`ADMIN_EMAILS` env allowlist). **Admin is read off the `users` row and
  requires `email_verified`**, never off the JWT's `email` claim alone: registration takes any
  address and answers with a session carrying it, so trusting the claim meant anyone could register
  a listed address that hadn't signed up yet and be an admin in one request. A factory, not a plain
  middleware, because that check needs the database.
- Account data lives in Postgres; schema in `database/migrations/init.sql`.

### 18+ content

Gated per user by a single `adult_content` boolean in `user_preferences` (set by hand from
Account → Preferences, no dedicated toggle). Off/absent/logged-out all mean no adult content.

- **`adult.service.ts`** (`AdultService.isAllowed(userId)`) resolves it, Redis-cached 60s, busted
  by preference writes (`AdultService.invalidate`). Only JSON `true` opens the gate — preferences
  are free-form JSON, a string `"true"` must not. Anonymous callers are always refused.
- **Enforcement is server-side** in `provider.router.ts`/`content.router.ts` (both `optionalAuth`)
  — these routes used to take no auth, so `fetchPublic`/`ensureSessionQuietly` in `auth.js` attach
  the token when present but never refresh/redirect (browsing logged out stays valid).
- **The signal is a single per-item flag**: `local_titles.adult`, set by hand by whoever adds the
  title, surfaced as `adult` on `Movie`/`TvShow`. No denylist, no whole-provider adult family, no
  separate maturity-rating preference — those existed for scraped sources that no longer exist.
  `Core`/`ProviderFamily` still support a whole-provider `adult: true` flag generically
  (`isAdultProvider()`), but `LocalProvider`'s family never sets it.
- **Individual titles** filtered from `/home`, `/search`, `/shows/:id` (403 on gated detail) via
  `adult-filter.service.ts` (`isAdultItem`/`filterItems`/`filterCategories`, reading `item.adult`
  as a plain JSON property). `episodes`/`servers`/`video` are *not* item-filtered (no cheap path
  back to the show) — someone holding an episode id can still resolve it.
- **Library rows** are `{provider, show_id}` only, with no `adult` flag to check — `filterAdultRows`
  in `account.router.ts` is a no-op today; a gated title is instead caught when `GET /api/shows/:id`
  403s, which `fetchShow` in `account.js` treats as permanent (drop the row).
- **Filtering happens after the cache**, in `adult-filter.service.ts` — `WebPlatformHandler`'s
  response cache stays global/unfiltered/keyed by provider only.

## Cross-cutting invariants (with `app/`)

Span both projects — changing one side alone breaks things local tests won't catch. Client half
described in `app/CLAUDE.md`.

- **Version handshake.** App sends `X-Client-Version`, reads `GET /api/version` for
  `updateAvailable`/`updateRequired`. Any request can 426 with a `client` payload once enforcement
  is on — handle globally, not just at startup, and never treat as an auth failure. Raise
  `minSupported` only once the newer build is published at `downloadUrl`.
- **Native auth.** Web keeps refresh token in an httpOnly cookie, unusable by native clients. App
  sends `X-Client: app`; `sendTokens` in `auth.router.ts` also returns the refresh token in the
  JSON body and accepts it back in the body on `/refresh`/`/logout`. OAuth uses an allowlisted
  `redirect_uri=streamio://auth`. **Browser behavior must stay byte-identical.**
- **A TV cannot do OAuth, so it pairs instead.** Android TV has no browser/https handler for its
  Custom Tab. `POST /api/auth/device/*` (`auth/deviceLogin.ts`): TV requests a code, shows it,
  polls; user approves from a phone at `/tv`. **The two codes aren't interchangeable** — the
  *user code* is short/on-screen/room-visible and can only *approve* (`/device/claim` is
  `requireAuth`, binds whoever's signed in); the *device code* is 32 random bytes, never leaves
  the TV, stored only as SHA-256, checked by `/device/token`. Swap the guard and reading a TV
  screen becomes account takeover. `/device/token` returns **200** for both pending and
  ready-session, **410** for expired/redeemed. Approved records get a shorter TTL than pending —
  from approval to redemption it's worth a session. `npm run test:device-login` covers the code
  helpers incl. alphabet parity with `public/scripts/tv.js`.
- **Only a rejected refresh token ends a session.** Refresh tokens rotate on use;
  `rotateRefreshToken` keeps a 60s grace window in Redis (`rtg:<hash>`) — a recently-retired token
  is still honored (client whose response was lost mid-rotation). A genuinely dead token is
  rejected on its own, never revokes other sessions. Both clients: only 401/403 *from
  `/api/auth/refresh` itself* clears stored tokens; 429/5xx/unfollowed redirect/offline are
  retryable and leave the session intact.
- **Redirects.** `dart:io` auto-follows GET/HEAD only, so the app follows all methods by hand,
  preserving method+body (unlike a browser, which downgrades a 302'd POST to GET). Keep this in
  mind before redirecting any write endpoint.
- **Path-prefixed installs.** `https://host/streamio` works: the proxy strips the prefix (routes
  register at root), but `APP_URL` must *include* it (`content.router.ts` derives
  `CAST_PUBLIC_BASE` from it; the Cast receiver has no page origin to resolve relative URLs
  against). Get it wrong and the master manifest loads while every segment 404s.
  **Refresh cookie must not be scoped from the prefix** — the frontend addresses the API
  root-relative, so a cookie at `/streamio/api/auth/refresh` is never sent from `/streamio/...`
  pages: login works, session dies at the first token expiry. `REFRESH_COOKIE_PATH` is therefore
  `/`; every set/clear also clears older narrower paths.
  Same trap, two more forms: the proxy resolves a manifest's relative children against the URL
  that **served** it (`upstream.url`), not the one requested — they differ whenever upstream
  redirects (an upstream redirector landing on a different host → wrong base, master loads,
  children 404). And `/api/cast-proxy?direct=1` rewrites child URIs **relative to the manifest's
  own URL**, deliberately not root-relative — a leading slash would drop the mount prefix.
- **A resolved stream carrying `headers` must be proxied, whatever its host** — those headers
  exist because forbidden fetch/XHR header names (Referer/Origin/`sec-fetch-*`) are needed, so
  only a server-side fetch can send them. `needsSourceProxy` (`watch.js`) keys off the payload for
  this reason rather than a hostname list, since a resolver's CDN host can be generated fresh per
  resolve. `LocalProvider.getVideo` never attaches headers — its URL is this server's own origin
  — so this path is exercised by any future provider that needs it, not by `local` today.
- **The Chromecast `customData` contract spans three repos.** `buildCastCustomData()`
  (`watch.js`) attaches provider/show/episode ids, artwork, episode list to every LOAD; Flutter
  sends the same shape (`app/lib/core/cast/cast_payload.dart`); the receiver (`cast-receiver`)
  consumes it to advance episodes/re-resolve dead streams. Canonical write-up is that repo's
  `docs/protocol.md`. **Every field must stay optional** — the receiver degrades field by field,
  and the no-customData path stays live for older app builds. Adding fields is safe anytime;
  removing/renaming needs coordination.
- **The receiver deploys on its own schedule** — a static page shared by every install, often
  newer than the backend it talks to, sometimes served stale from a device cache. The endpoints
  it calls itself (`/api/shows/:id`, `/api/seasons/:id/episodes`, `/api/episodes/:id/servers`,
  `POST /api/episodes/:id/video`, `/api/cast-proxy`, `/api/cast-log`) are a public contract in
  both directions, not internal routes.
- **Resolved streams are never cached client-side.** `POST /api/episodes/:id/video` returns
  signed URLs expiring in minutes; clients re-resolve per playback attempt, a paused download
  re-resolves before resuming. Don't switch to long-lived URLs without updating both clients.
