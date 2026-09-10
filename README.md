<div align="center">

<img src="public/icons/site-icon.png" alt="Streamio logo" width="120" height="120">

# Streamio

**Your movies. Your shows. Your server.**

A self-hosted streaming platform for your own media library — modern web UI, real accounts,
Chromecast, multi-server sync, and zero third-party content dependencies.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](docs/getting-started.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)](database/migrations)
[![Redis](https://img.shields.io/badge/Redis-cache-DC382D?logo=redis&logoColor=white)](database/redis.ts)
[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-lightgrey)](LICENSE)

[Getting Started](docs/getting-started.md) ·
[Documentation](docs/README.md) ·
[Features](docs/features.md) ·
[Architecture](docs/architecture.md) ·
[Report a bug](../../issues)

</div>

---

## What is Streamio?

Streamio is a Netflix-style front end for the movies and shows **you already own**. Upload once
through the admin "My Library" page, and it handles the rest: transcoding to HLS, a searchable
catalog, resumable watch history, per-user accounts, and casting to a TV — all running on
hardware you control, in one `docker compose up -d`.

There's no scraping, no third-party catalogue, and nothing calling out to the internet for
content. What you upload is what your server serves.

> **Note:** this build intentionally ships with a single content source — your own library. See
> [Architecture → Providers](docs/architecture.md#layering-routes--services--platformhandler--core--providers)
> for how that's wired, in case you ever want to add another one.

## Highlights

| | |
|---|---|
| **Your library, streamed properly** | Uploads are transcoded to adaptive HLS and served with resume-from-anywhere watch history. |
| **Real accounts** | Email/password + Google & Discord OAuth, JWT sessions, watchlists, favorites, ratings. |
| **Social** | Follow other users, share shows/episodes/clips, react with emoji. |
| **Watch parties** | Create a room, share a 6-character code, and watch in sync with friends — play/pause/seek/episode changes mirror live over WebSocket. |
| **Chromecast, done right** | A custom CAF receiver handles demuxed HLS audio/video correctly, where the default Cast receiver falls over. |
| **Multi-server sync** | Run more than one Streamio instance? Watchlist, favorites, ratings, history and follows merge across them, matched by account email. |
| **Power-aware self-hosting** | Optional idle auto-shutdown with a companion host-side power controller, so your box only runs while someone's actually watching. |
| **Updates that don't hurt** | Migrations apply automatically at boot, builds report their own version, and native clients get a version gate — with optional one-click self-update from GitHub releases. |

See [**Features**](docs/features.md) for the deep dive on sync, casting, watch parties, and
auto-shutdown.

## Quick Start

```bash
git clone https://github.com/streamio-org/streamio.git
cd streamio-website
cp .env.example .env      # fill in the required values — see docs/configuration.md
docker compose up -d
```

Open **http://localhost:8080**, create an account, and add your first title from the admin
"My Library" page.

Full walkthrough — including putting a reverse proxy in front for remote access — in
[**Getting Started**](docs/getting-started.md).

## Documentation

Everything beyond this quick tour lives in [`docs/`](docs/README.md):

| Guide | What's in it |
|---|---|
| [Getting Started](docs/getting-started.md) | Clone, configure, and run with Docker Compose |
| [Configuration](docs/configuration.md) | Every environment variable, grouped by feature |
| [Architecture](docs/architecture.md) | How the codebase is layered — routes → services → `Core` → providers, auth, watch parties, the frontend |
| [Features](docs/features.md) | Multi-server sync, Chromecast, watch parties, auto-shutdown |
| [Versioning & Updates](docs/versioning-and-updates.md) | Build identification, DB migrations, the client version gate, self-update |
| [Cheat Sheet](docs/cheatsheet.md) | Ship a change in three commands |
| [Development](docs/development.md) | Local dev loop, testing migrations, working on the updater |
| [Troubleshooting](docs/troubleshooting.md) | Symptom → cause → fix |

Three more pieces run **on the host itself**, not in Docker, each with its own setup guide:

| Subproject | Purpose |
|---|---|
| [`updater/`](updater/README.md) | Installs self-triggered updates from GitHub releases |
| [`power-controller/`](power-controller/README.md) | Powers the host off after idle time |
| [`login-checker/`](login-checker/README.md) | Presence beacon so `power-controller` doesn't shut down under an active user |

## Tech Stack

- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL (self-migrating at boot) + Redis (caching, rate limiting)
- **Frontend:** Static server-rendered HTML/CSS/JS, no build step, `hls.js` for playback
- **Realtime:** WebSocket-backed watch parties
- **Media:** Server-side transcoding to adaptive HLS
- **Auth:** JWT access/refresh tokens, Google & Discord OAuth, TV device-code pairing

## Contributing

Issues and pull requests are welcome. If you're planning something larger than a small fix,
open an issue first so we can talk through the approach before you invest the time.

## License

Copyright © 2026 Streamio.

Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) —
Attribution-NonCommercial-ShareAlike. You may share and adapt this project for non-commercial
purposes, with attribution, as long as you distribute your contributions under the same license.

See [`LICENSE`](LICENSE) for the full text.
