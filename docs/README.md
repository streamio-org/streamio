# Streamio Documentation

> A self-hosted streaming web application for your own media library, built for Docker.

This is the full documentation for Streamio. The top-level [README](../README.md) has a
one-paragraph overview and the fastest path to a running instance; everything else lives here.

## Contents

- **[Getting Started](getting-started.md)** — clone, configure, and run Streamio with Docker
  Compose, plus notes on putting a reverse proxy in front for remote access.
- **[Configuration](configuration.md)** — every environment variable, grouped by feature.
- **[Architecture](architecture.md)** — how the codebase is layered (routes → services /
  `PlatformHandler` → `Core` → providers), the services layer, auth, watch parties, and the
  frontend.
- **[Features](features.md)** — multi-server sync, Chromecast casting, auto-shutdown / power
  control, skip intro/recap/credits/preview.
- **[Versioning & Updates](versioning-and-updates.md)** — build identification, database
  migrations, the native client version gate, and self-update. The full reference.
- **[Cheat Sheet](cheatsheet.md)** — the update system on one page, for when you just need to
  ship a change.
- **[Development](development.md)** — local dev loop, working against the Docker stack, testing
  migrations and the version gate, working on the updater.
- **[Troubleshooting](troubleshooting.md)** — symptom → cause → fix, for updates, migrations, and
  deployment.

## Subproject docs

These live next to their own code, not here, since they're separate npm packages with their own
setup steps. The main app itself is Docker-only and runs identically regardless of host OS; these
three run **directly on the host**, so each README has a "Running it continuously" section indexed
by OS (Linux/systemd, Windows/Task Scheduler, macOS/launchd):

- [`updater/README.md`](../updater/README.md) — host-side self-update installer.
- [`power-controller/README.md`](../power-controller/README.md) — host-side auto-shutdown
  executor.
- [`login-checker/README.md`](../login-checker/README.md) — optional presence beacon for
  `power-controller`.

## For Claude Code

If you're an AI assistant working in this repository, read [`/CLAUDE.md`](../CLAUDE.md) first —
it documents the codebase architecture and conventions in the format Claude Code expects, and
supersedes this folder for that purpose.
