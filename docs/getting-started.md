# Getting Started

Streamio is a modern, self-hostable streaming platform inspired by **Streamflix**, but designed
as a **full web application** that runs entirely on your own server. Host it in minutes with
Docker Compose and get a clean interface, a personal media library, authentication, watch
history, and more.

This build serves only your own uploaded movies and shows — content is added by an admin through
the "My Library" admin page, not fetched from any external source.

## Features

- Modern responsive web interface
- Your own uploaded movies and shows ("My Library")
- Search movies and TV series
- Episode browser
- User accounts
- Watchlist, favorites & ratings
- Watch history with resume progress
- JWT authentication
- Google & Discord OAuth
- Social features: follow other users, share shows/episodes/clips with reactions
- Multi-server sync: merge watchlist, favorites, ratings, history and follows across
  independently hosted Streamio instances ("hosting points"), configurable by an admin
- Chromecast support via a custom receiver app (handles demuxed HLS audio/video correctly)
- Optional host auto-shutdown after idle time, with a companion host-side power-controller
- Seamless updates: schema migrations applied automatically at boot, build/version reporting, a
  version gate for native clients, and optional one-click (or unattended) self-update from GitHub
  releases

See [Features](features.md) for details on sync, casting, and auto-shutdown, and
[Architecture](architecture.md) for how it's all put together.

## Quick Start

### Clone the repository

```bash
git clone https://github.com/streamio-org/streamio-website.git
cd streamio-website
```

### Create your environment file

```bash
cp .env.example .env
```

Fill in the required values — see [Configuration](configuration.md) for the full reference.

### Start with Docker Compose

```bash
docker compose up -d
```

Open your browser:

```
http://localhost:8080
```

## Docker

Launch everything with:

```bash
docker compose up -d
```

Stop:

```bash
docker compose down
```

Update manually:

```bash
git pull
GIT_SHA=$(git rev-parse --short HEAD) BUILD_TIME=$(date -u +%FT%TZ) \
  docker compose up -d --build
```

Pending database migrations are applied automatically on startup. The `GIT_SHA`/`BUILD_TIME` vars
are what let `/health` report the exact build — without them it reports `commit: "unknown"`,
which is harmless but makes two builds of the same version indistinguishable. See
[Versioning & Updates](versioning-and-updates.md) for the automated path.

## Reaching the app remotely

This build has no bundled reverse-proxy/tunnel service — the `streamio` container listens on
`8080` and that's it. If you want the install reachable without port-forwarding, or behind a
stable hostname (Dynamic DNS, a Cloudflare Tunnel you run yourself, Caddy/nginx, ...), put that
in front of it yourself. Two things to get right either way:

- `APP_URL` must match the public origin users actually browse (see
  [Configuration](configuration.md)) — it's used for OAuth redirect URIs, email links, and the
  Chromecast proxy base.
- `/api/*` must be **proxied**, never redirected — a 302 there breaks Chromecast casting and
  OAuth callbacks. See [Architecture § Frontend](architecture.md#frontend-public) and
  [Features § Chromecast](features.md) for why.

## Tech Stack

- Node.js
- Express
- PostgreSQL
- Redis
- Docker
- TMDB API
- OAuth 2.0
- JWT
- TypeScript

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create your feature branch

   ```bash
   git checkout -b feature/my-feature
   ```

3. Commit your changes

   ```bash
   git commit -m "Add new feature"
   ```

4. Push the branch

   ```bash
   git push origin feature/my-feature
   ```

5. Open a Pull Request

## Disclaimer

This project is intended for educational and personal use only.

Streamio does not host, distribute, or provide copyrighted media on its own — this build only
serves media the server's own administrator has uploaded. Users are responsible for complying
with the laws applicable in their jurisdiction.

This project is heavily inspired by **Streamflix Reborn**, but reimagined as a complete
self-hosted web application.

## © Copyright

Copyright © 2026 Streamio. All rights reserved.

You may fork and modify this repository solely for the purpose of contributing changes back to
this project through a Pull Request.

Except for that limited permission, no part of this project may be copied, redistributed,
sublicensed, used in other projects, or commercially exploited without prior written permission
from the copyright holder.
