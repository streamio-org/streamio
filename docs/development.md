# Development

## The local loop

There is no hot reload from TypeScript source, and **`npm run dev` runs `dist/index.js`, not your
`.ts` files** — a stale `dist/` is the most common reason a change appears to do nothing. Run the
compiler in one terminal and the server in another:

```bash
npm run watch     # terminal 1 — tsc --watch, keeps dist/ current
npm run dev       # terminal 2 — nodemon on dist/index.js
```

For a quick correctness check without emitting anything — the fastest signal in this repo, since
there's no test runner or linter:

```bash
npx tsc --noEmit
cd updater && npx tsc --noEmit    # the subprojects have their own tsconfigs
```

Module resolution is ESM (`"type": "module"`), so **relative imports need a `.js` extension even
though the source is `.ts`**: `import { Migrator } from "./database/migrator.js"`.

## Pointing a local server at the Docker stack

`docker-compose.yml` doesn't publish Postgres or Redis on host ports, so a locally-run server can't
reach them at `localhost`. Use the container IPs:

```bash
DB=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' streamio-db)
REDIS=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' streamio-redis)
```

These change whenever the stack is recreated — re-read them rather than hardcoding.

> ⚠️ Don't point a dev server at the `streamio` database. It will migrate it. Use a scratch
> database, as below.

## Working on a migration

Write the file, then exercise it against a throwaway database rather than your real one. Creating
and dropping a database on the running Postgres is safe and leaves the live data untouched.

There's no `psql` on the host, but the database container ships one — `docker exec` is the easiest
way to reach it:

```bash
pg() { docker exec -i streamio-db psql -U postgres "$@"; }

pg -d postgres -c 'DROP DATABASE IF EXISTS migtest' -c 'CREATE DATABASE migtest'

DB=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' streamio-db)
npm run build
DATABASE_URL="postgresql://postgres:postgres@$DB:5432/migtest" \
  REDIS_URL="redis://$REDIS:6379" PORT=8099 node dist/index.js
```

Watch the boot log, then confirm the ledger:

```bash
pg -d migtest -c 'SELECT version, name, applied_at FROM schema_migrations ORDER BY version'
pg -d postgres -c 'DROP DATABASE migtest'    # clean up
```

Three cases are worth covering before you ship a migration, because they behave differently:

| Case | Set up by | Expected |
|---|---|---|
| **Fresh install** | Empty database | Every migration applies, in order |
| **Existing install** | Load `001_init.sql` by hand first, leaving the ledger empty | `001` **baselined**, only newer files applied |
| **Concurrent boots** | Run two `Migrator.run()` calls with `Promise.all` | One applies everything, the other applies nothing |

Re-running the server against the same database must be a no-op (`schema up to date`). If it isn't,
the migration isn't idempotent in the way the ledger assumes.

See [versioning-and-updates.md § 2](versioning-and-updates.md#2-database-migrations) for the
migration rules themselves.

## Testing the client version gate

The gate reads its policy from `app_settings`, so you can set it directly without an admin JWT:

```bash
pg -d migtest -c "INSERT INTO app_settings (key, value) VALUES ('client_version',
  '{\"latest\":\"2.0.0\",\"minSupported\":\"1.5.0\",\"downloadUrl\":\"https://example.com\",\"enforce\":true}')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
```

**The policy is cached in-process for 15 seconds** — wait it out before concluding a change didn't
take. Then check that all four behaviours hold:

```bash
curl -so /dev/null -w '%{http_code}\n' localhost:8099/api/providers                       # 200 (browser, never gated)
curl -so /dev/null -w '%{http_code}\n' -H 'X-Client: app' -H 'X-Client-Version: 2.0.0' localhost:8099/api/providers   # 200
curl -so /dev/null -w '%{http_code}\n' -H 'X-Client: app' -H 'X-Client-Version: 1.0.0' localhost:8099/api/providers   # 426
curl -so /dev/null -w '%{http_code}\n' -H 'X-Client: app' -H 'X-Client-Version: 1.0.0' localhost:8099/api/version     # 200 (always exempt)
```

A client sending no `X-Client-Version` at all is treated as older than any floor — it gets 426 too.

See [versioning-and-updates.md § 3](versioning-and-updates.md#3-telling-the-mobile-app-to-update)
for what the gate is protecting against.

## Working on the updater

It's a separate npm package with its own build, and **it runs from `dist/`, which isn't tracked**.
Updating the app therefore never updates the updater — if you change `updater/src/`, rebuild it by
hand:

```bash
cd updater && npm run build && sudo systemctl restart streamio-updater
journalctl -u streamio-updater -f
```

Keep `DRY_RUN=true` in `updater/.env` while developing: it exercises the full poll → auth → decide
path and logs what it *would* check out, without touching your working tree or rebuilding
anything.

To drive the internal endpoints directly, without waiting for a poll:

```bash
S=$(grep '^UPDATE_CONTROLLER_SECRET=' .env | cut -d= -f2)
curl -s -H "X-Update-Secret: $S" localhost:8080/internal/update/status | python3 -m json.tool
```

See [versioning-and-updates.md § 4](versioning-and-updates.md#4-self-update) for how the updater
fits into the release process.
