// tmdb-import.service.ts
//
// Snapshots exactly the fields a `local_titles`/`local_seasons`/`local_episodes`
// row needs out of a raw TMDB response, for the admin "fill in from a TMDB id"
// flow (routes/local-provider.router.ts). Deliberately calls `TMDb3` directly
// rather than going through `core/utils/TmbdUtilis.ts`'s `getMovieById`/
// `getTvShowById`: those build a full `Movie`/`TvShow` positionally, and
// `getMovieById` passes its genres array where the constructor expects
// `providerName` (missing that argument entirely) — a pre-existing bug this
// import path has no reason to inherit when all it actually wants is a handful
// of plain fields.
import { TMDb3 } from "../core/utils/TMDb3.js";

const IMAGE_BASE = "https://image.tmdb.org/t/p";

function image(path: string | null | undefined, size: string): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

export interface TmdbTitleSnapshot {
  title: string;
  overview: string | null;
  poster: string | null;
  banner: string | null;
  released: string | null;
  runtime: number | null;
  genres: string[];
  imdbId: string | null;
}

export interface TmdbEpisodeSnapshot {
  number: number;
  title: string | null;
  overview: string | null;
  poster: string | null;
  released: string | null;
}

export interface TmdbSeasonSnapshot {
  number: number;
  name: string | null;
  poster: string | null;
  episodes: TmdbEpisodeSnapshot[];
}

function requireApiKey(): void {
  if (!process.env.TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY is not configured on this server");
  }
}

export async function fetchTmdbMovieSnapshot(tmdbId: number): Promise<TmdbTitleSnapshot> {
  requireApiKey();
  const details = await TMDb3.Movies.details(tmdbId, { appendToResponse: ["external_ids"] });
  if (!details?.id) throw new Error(`TMDB movie ${tmdbId} not found`);

  return {
    title: details.title ?? details.original_title ?? "",
    overview: details.overview || null,
    poster: image(details.poster_path, "original"),
    banner: image(details.backdrop_path, "original"),
    released: details.release_date || null,
    runtime: typeof details.runtime === "number" ? details.runtime : null,
    genres: (details.genres ?? []).map((g: any) => g.name).filter(Boolean),
    imdbId: details.external_ids?.imdb_id ?? null,
  };
}

export async function fetchTmdbTvSnapshot(tmdbId: number): Promise<TmdbTitleSnapshot & { seasonNumbers: number[] }> {
  requireApiKey();
  const details = await TMDb3.TvSeries.details(tmdbId, { appendToResponse: ["external_ids"] });
  if (!details?.id) throw new Error(`TMDB tv show ${tmdbId} not found`);

  // Season 0 ("Specials") is real content but not what an admin importing a
  // show wants pre-created by default — left in the list, just sorted last,
  // matching how `Tmdb.ts` orders seasons for the same reason.
  const seasonNumbers = (details.seasons ?? [])
    .map((s: any) => s.season_number as number)
    .sort((a: number, b: number) => (a === 0 ? 1 : b === 0 ? -1 : a - b));

  return {
    title: details.name ?? details.original_name ?? "",
    overview: details.overview || null,
    poster: image(details.poster_path, "original"),
    banner: image(details.backdrop_path, "original"),
    released: details.first_air_date || null,
    runtime: null,
    genres: (details.genres ?? []).map((g: any) => g.name).filter(Boolean),
    imdbId: details.external_ids?.imdb_id ?? null,
    seasonNumbers,
  };
}

export async function fetchTmdbSeasonSnapshot(
  tmdbId: number,
  seasonNumber: number,
): Promise<TmdbSeasonSnapshot> {
  requireApiKey();
  const data = await TMDb3.TvSeasons.details(tmdbId, seasonNumber);

  return {
    number: seasonNumber,
    name: data?.name || null,
    poster: image(data?.poster_path, "w500"),
    episodes: (data?.episodes ?? []).map((e: any) => ({
      number: e.episode_number,
      title: e.name || null,
      overview: e.overview || null,
      poster: image(e.still_path, "w500"),
      released: e.air_date || null,
    })),
  };
}
