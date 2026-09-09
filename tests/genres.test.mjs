#!/usr/bin/env node
/**
 * Smoke test for `local`'s genre browsing.
 *
 * This used to be a comparative test against scraped catalogues, because
 * those sites answer an unrecognised filter with a well-formed page of their
 * *unfiltered* catalogue rather than an error — so "did we get titles back"
 * passed against a completely broken filter. `local`'s `getGenre` is a plain
 * `WHERE genres @> $1::jsonb` query (see `LocalProvider.ts`) with no upstream
 * to silently ignore the filter, but the comparative assertion is still worth
 * keeping: it catches a query that accidentally matches everything just as
 * well as it once caught a wrong query-param name.
 *
 * Requires `DATABASE_URL` pointed at a real, migrated database with at least
 * two distinct genres among its titles — with fewer than that, it reports so
 * rather than failing on data that isn't there to check.
 *
 * Usage:
 *   npm run test:genres          # run the check
 *   npm run test:genres -- --json
 *
 * Requires a build first (`npm run build`); the npm script does it for you.
 * Exit code is non-zero if any step fails.
 */

import { Core } from "../dist/core/core.js";
import { Database } from "../dist/database/db.js";

const jsonOutput = process.argv.includes("--json");
function log(...a) {
  if (!jsonOutput) console.log(...a);
}

function idsOf(genre) {
  return new Set((genre?.shows ?? []).map((s) => s.id));
}

async function main() {
  const db = new Database();
  const core = new Core(db);

  if (!core.getListOfProviders().includes("local")) {
    log("`local` is not registered — is DATABASE_URL set?");
    await db.close();
    process.exitCode = 1;
    return;
  }

  const result = { provider: "local", ok: true, note: "" };

  if (!core.supportsGenres("local")) {
    result.ok = false;
    result.note = "local provider does not support genre browsing";
  } else {
    const genres = await core.getGenres("local");
    if (genres.length < 2) {
      result.note = `only ${genres.length} genre(s) in the library — nothing to compare`;
    } else {
      const [a, b] = genres;
      const pageA = await core.getGenre("local", a.id, 1);
      const pageB = await core.getGenre("local", b.id, 1);
      const idsA = idsOf(pageA);
      const idsB = idsOf(pageB);

      if (idsA.size === 0 && idsB.size === 0) {
        result.note = `both "${a.name}" and "${b.name}" came back empty — nothing to compare`;
      } else if ([...idsA].every((id) => idsB.has(id)) && idsA.size === idsB.size) {
        result.ok = false;
        result.note = `"${a.name}" and "${b.name}" returned the same page — filter looks ignored`;
      } else {
        result.note = `"${a.name}" (${idsA.size}) and "${b.name}" (${idsB.size}) differ as expected`;
      }
    }
  }

  await db.close();

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    log(result.ok ? `✔ ${result.note}` : `✘ ${result.note}`);
  }

  if (!result.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
