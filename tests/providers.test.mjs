#!/usr/bin/env node
/**
 * Smoke test for the `local` provider.
 *
 * This used to drive every registered provider against its real upstream
 * site — the useful thing to test about a scraper is whether upstream markup
 * still parses. `local` scrapes nothing: it reads `local_titles`/
 * `local_seasons`/`local_episodes`/`local_media_files` straight out of this
 * server's own Postgres, so there is no upstream to break. What's worth
 * checking instead is that the registry/dispatch plumbing (`Core`,
 * `PlatformHandler`) still round-trips a title that's actually in the
 * database, end to end: home → search → details → episodes → servers →
 * resolved stream.
 *
 * Requires `DATABASE_URL` pointed at a real, migrated database (the same one
 * the server itself would use) with at least one `ready` local title in it —
 * this is a smoke test against real data, not a fixture. With nothing to
 * find, it reports that plainly rather than failing on an empty catalogue.
 *
 * Usage:
 *   npm run test:providers                # walk one movie and one show, if present
 *   npm run test:providers -- --no-stream # skip the stream-reachability probe
 *   npm run test:providers -- --json      # machine-readable summary
 *
 * Requires a build first (`npm run build`); the npm script does it for you.
 * Exit code is non-zero if any step fails.
 */

import { Core } from "../dist/core/core.js";
import { Database } from "../dist/database/db.js";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const probeStream = !args.includes("--no-stream");

function log(...a) {
  if (!jsonOutput) console.log(...a);
}

async function probeUrl(url) {
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1" } });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

async function walk(core, item, results) {
  const kind = item.constructor.name; // "Movie" | "TvShow"
  const label = `${kind} "${item.title}" (${item.id})`;

  try {
    const details = await core.getShowDetails("local", item.id);
    if (!details?.title) throw new Error("getShowDetails returned nothing");

    let episodeId = item.id;
    if (kind === "TvShow") {
      const season = details.seasons?.[0];
      if (!season) throw new Error("show has no seasons");
      const episodes = await core.getEpisodes("local", season.id);
      const episode = episodes[0];
      if (!episode) throw new Error("season has no episodes");
      episodeId = episode.id;
    }

    const servers = await core.getServers("local", episodeId);
    if (!servers.length) {
      results.push({ label, ok: true, note: "no ready file yet — nothing to resolve" });
      return;
    }

    const video = await core.resolveVideo("local", servers[0]);
    const url = video?.playlistUrl || video?.source;
    if (!url) throw new Error("resolveVideo returned no URL");

    if (probeStream) {
      const reachable = await probeUrl(url);
      if (!reachable) throw new Error(`stream not reachable: ${url}`);
    }

    results.push({ label, ok: true });
  } catch (err) {
    results.push({ label, ok: false, error: err.message });
  }
}

async function main() {
  const db = new Database();
  const core = new Core(db);

  const providers = core.getListOfProviders();
  const results = [];

  if (!providers.includes("local")) {
    log("`local` is not registered — is DATABASE_URL set?");
    process.exitCode = 1;
    return;
  }

  const home = await core.getHome("local");
  const items = home.flatMap((c) => c.list ?? []);

  if (!items.length) {
    log("`local` has no titles yet — nothing to walk. This is not a failure.");
  } else {
    const movie = items.find((i) => i.constructor.name === "Movie");
    const show = items.find((i) => i.constructor.name === "TvShow");
    for (const item of [movie, show].filter(Boolean)) {
      await walk(core, item, results);
    }
  }

  await db.close();

  if (jsonOutput) {
    console.log(JSON.stringify({ provider: "local", results }, null, 2));
  } else {
    for (const r of results) {
      log(r.ok ? `✔ ${r.label}${r.note ? ` (${r.note})` : ""}` : `✘ ${r.label}: ${r.error}`);
    }
  }

  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
