# Cheat Sheet

The whole update system on one page. Long version: [versioning-and-updates.md](versioning-and-updates.md).

## Ship a change

```bash
# 1. save your work
git add -A && git commit -m "what you changed"
git push

# 2. bump the version, commit, tag, push, and publish the Release — all in one go
npm run release
```

`npm run release` (`scripts/release.sh`) asks whether it's a major/minor/patch bump and for a
description, then does steps 2–3 below for you (bump `package.json`, commit `Release X.Y.Z`, tag,
push, `gh release create`) — confirming before anything is pushed. Prefer it over the manual
commands. It requires a clean working tree and `gh` to be authenticated.

Doing it by hand instead:

```bash
# 2. bump the version in package.json  ("1.0.0" → "1.0.1")
git commit -am "Release 1.0.1" && git push

# 3. publish it
gh release create v1.0.1 --title "v1.0.1" --notes "what you changed"
```

Then open **Account → Admin → Updates** and press **Check for Updates**, then **Install Update**.

That's it. The server downloads it, rebuilds, restarts, and updates the database by itself.

## The one rule

> **`package.json` and the tag must have the same number, and it must go up.**

You're on `1.0.0`. Next is `1.0.1`.

Tag without bumping `package.json`, or bump without publishing a Release, and **nothing happens
and nothing complains**. That's the only real trap.

## Need a new database table?

Drop a file in `database/migrations/` named with the next number:

```
database/migrations/003_whatever.sql
```

Ship it as above. It applies itself when the server restarts. Never touch the database by hand.

Rules: numbers only go up, and **never edit a file you've already shipped** — write a new one.

See [development.md § Working on a migration](development.md#working-on-a-migration) for how to
test one before shipping.

## Where things are

| | |
|---|---|
| Admin controls | Account page → **Admin** tab |
| What's running now | `curl localhost:8080/health` |
| Did it work? | `journalctl -u streamio-updater -f` |
| Update history | Admin tab → Updates → Recent updates |

## When it doesn't work

See [troubleshooting.md](troubleshooting.md) for the full list. The two most common:

**"Up to date" but you just published a release**
The tag number isn't higher than `package.json`. See [the one rule](#the-one-rule).

**Pressed Install and nothing happened**
The admin page will keep saying "update pending" — the request was fine, the helper on your PC
didn't carry it out. See [troubleshooting.md](troubleshooting.md#pressed-install-and-nothing-happened).

**Deploying by hand instead**

```bash
git pull
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) \
  docker compose up -d --build streamio
```

## Currently switched off

| Thing | Where to turn it on |
|---|---|
| Auto-install (no asking) | Admin → Updates → *Install automatically* |
| Blocking outdated phone apps | Admin → App Version Policy → *Block outdated apps* |
| Real updates (vs. pretend) | `DRY_RUN=false` in `updater/.env` |
