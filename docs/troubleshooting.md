# Troubleshooting

Symptom-driven fixes for updates, migrations, and deployment. See
[versioning-and-updates.md](versioning-and-updates.md) for how the whole system works, and
[cheatsheet.md](cheatsheet.md) for the fast path.

## "Up to date" but you just published a release

The tag number isn't higher than `package.json`. See
[the one rule](cheatsheet.md#the-one-rule): both must go up together.

## Red error in the Updates box (admin UI)

It says what's wrong. Usually the GitHub token expired — get a new one with `gh auth token` and
put it in `.env` as `UPDATE_GITHUB_TOKEN`, then restart the container.

## `updateAvailable` is always false, `lastCheckError` mentions 404

The repo is private and `UPDATE_GITHUB_TOKEN` is empty or expired. `git ls-remote` succeeding
proves nothing — that uses your local git credentials, not the server's token.

## `lastCheckError` is null but `latest` is null

No published *Release* exists. Tags alone don't count; `/releases/latest` only returns releases.

## A release exists but nothing installs

Its tag isn't strictly greater than the running `package.json` version. Republishing the current
version is a no-op by design.

## `/health` reports `commit: "unknown"`

Built without `GIT_SHA`. Harmless, but you lose the ability to tell two builds of the same version
apart. See [versioning-and-updates.md § 1](versioning-and-updates.md#1-what-build-am-i-running).

## Pressed Install and nothing happened

The admin page will keep saying "update pending" — the request was fine, the helper on your PC
didn't carry it out. Check it, in this order:

```bash
journalctl -u streamio-updater -n 30   # the real reason is always in here
systemctl status streamio-updater      # should say "active"
cd updater && npm run build            # fixes it if it's crash-looping
```

Two things that look like "nothing happened":

- `DRY_RUN=true` in `updater/.env` — the helper only *pretends* to update.
- `fatal: detected dubious ownership` in the log — the service is running as the wrong user (see
  below).

## The updater service restarts in a loop

`updater/dist` was never built. `cd updater && npm run build`, then restart the service.

## The admin page says "update pending" forever

The app did its part; the host updater didn't finish. `journalctl -u streamio-updater -n 30`
always has the reason. Note that a failure *before* the attempt is registered isn't recorded in
`update_history` and doesn't clear the pending flag — the updater simply retries on the next poll,
so the UI keeps showing "pending" with no error. The log is the source of truth.

## `fatal: detected dubious ownership in repository`

The service is running as a different user than the one who owns `REPO_DIR` — by default systemd
runs it as root. Git refuses to touch a repo it doesn't trust, so the update fails before it
starts. Set `User=` in the service file to the checkout's owner (that user must also be in the
`docker` group). Adding a `safe.directory` exception for root "works" too, but then root-owned
files land in your working tree — don't.

## Uncommitted work vanished from the deploy checkout

The updater runs `git checkout --force` when installing an update, which discards it. There is no
recovery beyond `git reflog` for anything that was at least committed. Keep the deploy checkout
clean, or point `REPO_DIR` at a clone you don't hack on.

## Deploying by hand instead

If the update pipeline is broken and you just need to get a build out:

```bash
git pull
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) \
  docker compose up -d --build streamio
```

Migrations still apply automatically on the way up.
