# Versioning & Updates

How Streamio knows which build it is, keeps its database schema in step with its code, tells
native clients to update, and installs new releases of itself.

These are four separate mechanisms that are deliberately **not** wired together. You can use the
migration runner without ever enabling self-update, and gate the mobile app without publishing a
single release.

> 🚀 **Just want to ship a change?** [cheatsheet.md](cheatsheet.md) has it in three commands.
> Everything below is the reference for when something needs explaining. For the day-to-day dev
> loop (running the compiler, testing migrations, testing the version gate), see
> [development.md](development.md).

Most of this is also available in the UI: **account page → Admin tab**.

## 1. What build am I running?

The version has two halves, and they answer different questions:

| | Where it comes from | What it's for |
|---|---|---|
| `version` | `package.json` (`1.0.0`) | The human version. What release tags are compared against. |
| `commit` | Short git SHA, baked in at image build time | The exact build. Two images can share a version but not a commit. |

Both are read by [`version.ts`](../version.ts). Nothing inspects `.git` at runtime — the Docker
build context excludes it — so the SHA arrives as a build argument:

```
docker-compose.yml (args) → Dockerfile (ARG GIT_SHA) → ENV → version.ts
```

That means **a manual `docker compose up -d --build` reports `commit: "unknown"` unless you pass
it**:

```bash
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) \
  docker compose up -d --build streamio
```

The updater does this automatically. Check what's live at any time:

```bash
curl -s localhost:8080/health
# {"status":"ok","service":"streamio-api","version":"1.0.0","commit":"78f13c6","apiVersion":1}
```

`apiVersion` is a third, independent number (`API_VERSION` in `version.ts`). It describes the HTTP
contract, not the build — bump it **only** when you break that contract, and never tie it to the
semver.

## 2. Database migrations

### The rule

**Starting the server applies pending migrations first.** There is no separate migrate command,
and no way to run the app against a stale schema — if a migration fails, the process exits rather
than serving new code against an old database.

This replaced the old `docker-entrypoint-initdb.d` mount, which only ever ran on a *fresh* Postgres
volume. Any install that already had data silently never received schema changes.

### Adding one

Create `database/migrations/<number>_<name>.sql`:

```
database/migrations/
  001_init.sql             ← the original schema
  002_update_history.sql
  003_add_devices.sql      ← yours
```

- Numbers strictly increase and are never reused.
- Each file runs inside a single transaction — it fully applies or not at all.
- **Once committed and deployed, a migration file is immutable.** Editing one is detected by
  checksum and warned about in the logs, but never re-run. Write a new file instead.

Deploy normally. The next boot applies it:

```
[migrator] applying 003_add_devices.sql...
[migrator] applied 1 migration(s)
```

### What it protects you from

- **Double-applying.** A whole run holds one pooled connection and a Postgres advisory lock, so two
  containers booting simultaneously can't both apply the same file. The loser waits, then finds
  nothing to do.
- **Existing installs.** A database that predates the migrator has the full `001` schema but an
  empty ledger. It gets **baselined** — `001` is recorded as applied without being replayed — and
  real migrations start from `002`.

Inspect the ledger any time:

```sql
SELECT version, name, applied_at FROM schema_migrations ORDER BY version;
```

> ⚠️ Anything that touches the database at startup belongs in `WebServer.start()`, **not** the
> constructor — the constructor runs before migrations, against a schema that may not exist yet.

## 3. Telling the mobile app to update

`GET /api/version` is public and unauthenticated, because a client too old to log in still has to
be able to find out that it's too old.

```bash
curl -s -H 'X-Client: app' -H 'X-Client-Version: 0.9.0' localhost:8080/api/version
```

```json
{
  "server": { "version": "1.0.0", "commit": "78f13c6", "builtAt": "..." },
  "api":    { "version": 1 },
  "client": {
    "latest": "1.0.0", "minSupported": "1.0.0", "downloadUrl": null, "notes": null,
    "current": "0.9.0", "updateAvailable": true, "updateRequired": true, "enforced": false
  }
}
```

If the client sends `X-Client-Version`, the server does the comparison for it — no client
re-implements semver.

| Field | Meaning |
|---|---|
| `latest` | Newest published build. Below it → *prompt* to update. |
| `minSupported` | Oldest accepted build. Below it → *must* update. |
| `enforced` | Whether that floor is actually being enforced (see below). |

### Turning the floor into a hard block

While `enforce` is off, `minSupported` is advisory — the app decides what to do about it. Turn it
on and [`auth/clientVersion.ts`](../auth/clientVersion.ts) rejects every request from a client
below the floor with **426 Upgrade Required** and a payload naming the download URL:

```bash
curl -X PUT https://<host>/api/settings/client-version \
  -H "Authorization: Bearer <admin token>" -H "Content-Type: application/json" \
  -d '{"latest":"1.1.0","min_supported":"1.1.0","download_url":"https://...","enforce":true}'
```

Only requests carrying `X-Client: app` are gated — browsers run the frontend this server just
served them, so they're never stale in the way this guards against. `/api/version` and `/health`
stay reachable regardless, so a blocked client can still learn why.

> ⚠️ Raising `minSupported` locks out every build below it **immediately**. Raise it only once the
> newer build is actually downloadable at `downloadUrl`, and note that a 426 can arrive at any
> point in the app's lifetime — it has to be handled globally, and must never be mistaken for an
> auth failure that clears tokens.

Defaults come from `CLIENT_LATEST_VERSION` / `CLIENT_MIN_VERSION` / `CLIENT_DOWNLOAD_URL` in
`.env`; anything set through the admin API overrides them without a redeploy.

## 4. Self-update

### Why there's a second process

The app runs in Docker. Installing an update means checking out a new tag and rebuilding the very
image the app is running from — it cannot do that to itself. So the work is split, exactly like
[`power-controller/`](../power-controller/README.md):

- **The app decides.** It compares the latest GitHub release against its own version and flags
  whether an update should happen. It has no git or Docker privileges.
- **[`updater/`](../updater/README.md) acts.** A small process on the host (not in Docker) polls
  `GET /internal/update/status` (shared-secret gated) and carries the update out.

### Cutting a release

The check compares the release tag's semver against the running `package.json` version, so those
two have to agree.

The easy way — `npm run release` (`scripts/release.sh`) does all of the below interactively: it
checks the tree is clean and in sync with `origin`, prompts for major/minor/patch and a
description, bumps `package.json`/`package-lock.json`, commits `Release X.Y.Z`, tags, pushes, and
runs `gh release create` with that description as the notes — asking for confirmation before
anything is pushed. Requires `gh` to be authenticated.

By hand:

```bash
# 1. bump package.json ("version": "1.0.1") and commit it
git commit -am "Release 1.0.1"
git push

# 2. publish a GitHub *Release* — a bare tag is not enough,
#    /releases/latest only returns published releases
gh release create v1.0.1 --title "v1.0.1" --notes "..."
```

Both `v1.0.1` and `1.0.1` work as tags. **The tag must be strictly greater than the running
version** — republishing the current version installs nothing, by design.

### Installing it

```bash
# see what's available (bypasses the 30-minute release cache)
curl -X POST https://<host>/api/settings/update/check -H "Authorization: Bearer <admin token>"

# install it
curl -X POST https://<host>/api/settings/update/apply -H "Authorization: Bearer <admin token>"
```

`apply` sets a flag with a 30-minute TTL; the updater picks it up on its next poll. With
`auto_apply: true`, new releases install as soon as they're seen, with no approval step.

### What actually happens

1. `POST /internal/update/start` — records the attempt in `update_history` **and clears the pending
   flag**, before anything is touched. That ordering is what stops the replacement container from
   being handed the same update again.
2. `git fetch --tags` and check out the target tag.
3. `docker compose build streamio` — the old container keeps serving throughout. A build failure
   costs **zero** downtime.
4. `docker compose up -d streamio` — the only moment the app is actually down.
5. Wait for `/health` to report the new version. The new container runs its own migrations at boot,
   so there is no separate schema step and no window where new code meets an old schema.
6. `POST /internal/update/finish` — result recorded.

Any failure rolls the checkout back to the previous ref, rebuilds it, and records the error.

```bash
curl -s https://<host>/api/settings/update/history -H "Authorization: Bearer <admin token>"
```

> ⚠️ Step 2 is `git checkout --force`, which **silently discards uncommitted changes** in the
> deploy checkout. Keep that tree clean, or point `REPO_DIR` at a clone you don't hack on.

## 5. Shipping a change end to end

The full path from an edit to an install, pulling the pieces above together:

```bash
# 1. develop
npx tsc --noEmit                       # type-check
#    if the schema changed, add database/migrations/<n>_<name>.sql and test it (development.md)

# 2. commit — the deploy checkout must be clean, `git checkout --force` discards anything left
git add -A && git commit -m "..."
git push

# 3 & 4. bump the version, commit, tag, push, and publish a Release — all interactively
npm run release
#    or by hand:
#    edit package.json: "version": "1.0.1"
#    git commit -am "Release 1.0.1" && git push
#    gh release create v1.0.1 --title "v1.0.1" --notes "..."

# 5. install — or let auto_apply do it
curl -X POST https://<host>/api/settings/update/check -H "Authorization: Bearer <admin token>"
curl -X POST https://<host>/api/settings/update/apply -H "Authorization: Bearer <admin token>"
```

Steps 3 and 4 are the two that are easy to get wrong: a tag that doesn't bump `package.json`, or a
bumped `package.json` with no published Release, both leave the updater with nothing to install and
no error to show for it.

Watch it land:

```bash
journalctl -u streamio-updater -f
curl -s https://<host>/health          # version + commit should both change
```

If you'd rather deploy by hand and skip the release machinery entirely, that still works — just
remember the build stamp:

```bash
git pull
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) \
  docker compose up -d --build streamio
```

Migrations apply on the way up either way.

## Configuration

### Server (`.env`)

| Variable | Purpose |
|---|---|
| `UPDATE_CONTROLLER_SECRET` | Shared secret the updater sends as `X-Update-Secret`. Must match `updater/.env`. |
| `UPDATE_REPO` | `owner/name` releases are published to. A default only — the admin API overrides it. |
| `UPDATE_GITHUB_TOKEN` | **Required for a private repo.** Needs `Contents: read`. |
| `CLIENT_LATEST_VERSION` | Fallback for `/api/version`'s `latest`. |
| `CLIENT_MIN_VERSION` | Fallback for `minSupported`. |
| `CLIENT_DOWNLOAD_URL` | Where a too-old client should go. |

### Host (`updater/.env`)

See [`updater/README.md`](../updater/README.md). The ones that matter most: `REPO_DIR` (the
checkout that gets rebuilt), `UPDATE_CONTROLLER_SECRET` (must match the server), and `DRY_RUN`
(logs what it would do without touching anything — leave it on until you've watched a poll succeed).

### Admin endpoints

All require an admin JWT (`ADMIN_EMAILS`).

| Endpoint | Purpose |
|---|---|
| `GET /api/settings/update` | Current status: running version, latest release, whether one is available |
| `PUT /api/settings/update` | `{enabled, auto_apply, repo}` |
| `POST /api/settings/update/check` | Force a release check now |
| `POST /api/settings/update/apply` | Request installation |
| `POST /api/settings/update/cancel` | Withdraw that request |
| `GET /api/settings/update/history` | Past attempts |
| `GET`/`PUT /api/settings/client-version` | Client version policy |

For local development of these mechanisms (dev loop, testing migrations, testing the version
gate, working on the updater), see [development.md](development.md). For symptom-driven fixes,
see [troubleshooting.md](troubleshooting.md).
