import {
  Movie,
  TvShow,
  Episode,
  Season,
  Category,
  Genre,
  Provider,
  Video,
  Show,
} from "../models/index.js";
import type { GenreCapableProvider } from "../models/Provider.js";
import type { Database } from "../../database/db.js";
import { appBaseUrl } from "../../version.js";
import type { ProviderModule } from "../models/ProviderRegistry.js";

type VideoServer = { id: string; name: string; src: string };

/**
 * Wire id scheme, deliberately mirroring `Tmdb.ts`'s prefixing exactly
 * (`movie-<id>`, `tv-<id>`, `tv-<id>#season-<n>`, `tv-<id>#s<n>e<m>`) so
 * `Core.getShowDetails`'s movie/tv probing works unchanged. `<id>` here is a
 * `local_titles.id` UUID rather than a TMDB integer, which is why the prefix
 * is `local-movie-`/`local-tv-` — a bare `movie-<uuid>` id could collide with
 * nothing today, but the prefix makes the provenance obvious in a saved
 * watchlist/history row.
 */
type Ref =
  | { kind: "movie"; id: string }
  | { kind: "tv"; id: string }
  | { kind: "season"; id: string; season: number }
  | { kind: "episode"; id: string; season: number; episode: number };

function localMovieId(id: string): string {
  return `local-movie-${id}`;
}

function localTvId(id: string): string {
  return `local-tv-${id}`;
}

function localSeasonRefId(titleId: string, season: number): string {
  return `${localTvId(titleId)}#season-${season}`;
}

function localEpisodeRefId(titleId: string, season: number, episode: number): string {
  return `${localTvId(titleId)}#s${season}e${episode}`;
}

function parseRef(raw: string): Ref | null {
  const [head, frag] = (raw ?? "").trim().split("#");
  const m = head?.match(/^local-(movie|tv)-(.+)$/);
  if (!m) return null;

  const kind = m[1] as "movie" | "tv";
  const id = m[2];

  if (!frag) return { kind, id } as Ref;
  if (kind !== "tv") return null;

  const season = frag.match(/^season-(\d+)$/);
  if (season) {
    return { kind: "season", id, season: parseInt(season[1], 10) };
  }

  const episode = frag.match(/^s(\d+)e(\d+)$/);
  if (episode) {
    return {
      kind: "episode",
      id,
      season: parseInt(episode[1], 10),
      episode: parseInt(episode[2], 10),
    };
  }

  return null;
}

/** Postgres hands back DATE/TIMESTAMPTZ columns as `Date` objects already;
 *  the model constructors want the `YYYY-MM-DD` string they parse back into
 *  one, so this just undoes that round trip explicitly rather than relying
 *  on `new Date(existingDate)` coercion. */
function dateStr(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function toGenres(names: string[] | null | undefined): Genre[] {
  return (names ?? []).map((name) => new Genre(name, name));
}

interface LocalTitleRow {
  id: string;
  media_type: "movie" | "tv";
  title: string;
  overview: string | null;
  poster: string | null;
  banner: string | null;
  released: Date | string | null;
  runtime: number | null;
  genres: string[];
  imdb_id: string | null;
  adult: boolean;
  file_id: string | null;
}

interface LocalSeasonRow {
  id: string;
  title_id: string;
  number: number;
  name: string | null;
  poster: string | null;
}

interface LocalEpisodeRow {
  id: string;
  season_id: string;
  number: number;
  title: string | null;
  overview: string | null;
  poster: string | null;
  released: Date | string | null;
  file_id: string | null;
}

const PAGE_SIZE = 24;

/**
 * The only provider: backed by this server's own database and disk, not a
 * scraped site or a third-party API. Movies/shows are created and their video
 * files uploaded through the admin-only `/api/admin/local-provider` router
 * (routes/local-provider.router.ts); this class only ever reads what that
 * router (and the transcode pipeline behind it) has written.
 *
 * `getServers` answers honestly rather than erroring: a title/episode whose
 * file hasn't finished transcoding yet gets an empty server list, not an
 * error — "not ready" and "nothing to play" look the same to a client either
 * way.
 */
export class LocalProvider extends Provider implements GenreCapableProvider {
  constructor(private db: Database) {
    super("local", "", "en");
  }

  // ------------------------------------------------------------------
  // Mapping
  // ------------------------------------------------------------------

  private toMovie(row: LocalTitleRow): Movie {
    return new Movie(
      localMovieId(row.id),
      row.title,
      row.overview,
      dateStr(row.released),
      row.runtime,
      null,
      null,
      null,
      row.poster,
      row.banner,
      row.imdb_id,
      this.getName(),
      toGenres(row.genres),
      [],
      [],
      [],
      false,
      row.adult === true,
    );
  }

  private toTvShow(row: LocalTitleRow, seasons: Season[] = []): TvShow {
    return new TvShow(
      localTvId(row.id),
      row.title,
      row.overview,
      dateStr(row.released),
      null,
      null,
      null,
      null,
      row.poster,
      row.banner,
      row.imdb_id,
      this.getName(),
      seasons,
      toGenres(row.genres),
      [],
      [],
      [],
      false,
      row.adult === true,
    );
  }

  private toSeason(row: LocalSeasonRow, tvShow: TvShow | null): Season {
    return new Season(
      localSeasonRefId(row.title_id, row.number),
      row.number,
      row.name,
      row.poster,
      tvShow,
      [],
    );
  }

  private toEpisode(
    row: LocalEpisodeRow,
    titleId: string,
    seasonNumber: number,
    tvShow: TvShow | null,
    season: Season | null,
  ): Episode {
    return new Episode(
      localEpisodeRefId(titleId, seasonNumber, row.number),
      row.number,
      row.title,
      dateStr(row.released),
      row.poster,
      row.overview,
      tvShow,
      season,
    );
  }

  private toItem(row: LocalTitleRow): Movie | TvShow {
    return row.media_type === "movie" ? this.toMovie(row) : this.toTvShow(row);
  }

  // ------------------------------------------------------------------
  // Home / search
  // ------------------------------------------------------------------

  public override async getHome(): Promise<Category[]> {
    const rows = await this.db.all<LocalTitleRow>(
      `SELECT * FROM local_titles ORDER BY created_at DESC LIMIT 50`,
    );
    if (!rows.length) return [];
    return [new Category("Recently added", rows.map((r) => this.toItem(r)))];
  }

  public override async search(query: string, page: number = 1): Promise<(Movie | TvShow)[]> {
    const q = (query ?? "").trim();
    if (!q) return [];

    const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
    const rows = await this.db.all<LocalTitleRow>(
      `SELECT * FROM local_titles WHERE title ILIKE $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [`%${q}%`, PAGE_SIZE, offset],
    );
    return rows.map((r) => this.toItem(r));
  }

  // ------------------------------------------------------------------
  // Details
  // ------------------------------------------------------------------

  /**
   * `Core.getShowDetails` probes: it tries `getTvShow` before `getMovie` and
   * only falls back when the result has no title. An id of the other kind is
   * that probe missing, not an error — matches `TmdbProvider.getMovie`.
   */
  public override async getMovie(id: string): Promise<Movie> {
    const ref = parseRef(id);
    if (!ref || ref.kind !== "movie") return new Movie();

    const row = await this.db.one<LocalTitleRow>(
      `SELECT * FROM local_titles WHERE id = $1 AND media_type = 'movie'`,
      [ref.id],
    );
    if (!row) return new Movie();

    return this.toMovie(row);
  }

  public override async getTvShow(id: string): Promise<TvShow> {
    const ref = parseRef(id);
    if (!ref || ref.kind !== "tv") return new TvShow();

    const row = await this.db.one<LocalTitleRow>(
      `SELECT * FROM local_titles WHERE id = $1 AND media_type = 'tv'`,
      [ref.id],
    );
    if (!row) return new TvShow();

    const tvShow = this.toTvShow(row);
    const seasonRows = await this.db.all<LocalSeasonRow>(
      `SELECT * FROM local_seasons WHERE title_id = $1 ORDER BY number ASC`,
      [ref.id],
    );
    tvShow.seasons = seasonRows.map((s) => this.toSeason(s, tvShow));

    return tvShow;
  }

  public override async getEpisodesBySeason(seasonId: string): Promise<Episode[]> {
    const ref = parseRef(seasonId);
    if (!ref || ref.kind !== "season") return [];

    const seasonRow = await this.db.one<LocalSeasonRow>(
      `SELECT * FROM local_seasons WHERE title_id = $1 AND number = $2`,
      [ref.id, ref.season],
    );
    if (!seasonRow) return [];

    const episodeRows = await this.db.all<LocalEpisodeRow>(
      `SELECT * FROM local_episodes WHERE season_id = $1 ORDER BY number ASC`,
      [seasonRow.id],
    );
    return episodeRows.map((e) => this.toEpisode(e, ref.id, ref.season, null, null));
  }

  // ------------------------------------------------------------------
  // Genres — the `genres` jsonb array already on each title, no separate
  // catalog to keep in sync. id === name: there is no external genre
  // catalog to key off, unlike a scraped site's numeric genre id.
  // ------------------------------------------------------------------

  public async getGenres(): Promise<Genre[]> {
    const rows = await this.db.all<{ genres: string[] }>(`SELECT genres FROM local_titles`);
    const names = new Set<string>();
    for (const row of rows) {
      for (const name of row.genres ?? []) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => new Genre(name, name));
  }

  public async getGenre(id: string, page: number = 1): Promise<Genre> {
    const offset = (Math.max(1, page) - 1) * PAGE_SIZE;
    const rows = await this.db.all<LocalTitleRow>(
      `SELECT * FROM local_titles WHERE genres @> $1::jsonb ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [JSON.stringify([id]), PAGE_SIZE, offset],
    );
    return new Genre(id, id, rows.map((r) => this.toItem(r)) as unknown as Show[]);
  }

  // ------------------------------------------------------------------
  // Servers / video
  // ------------------------------------------------------------------

  private async fileIdFor(ref: Ref): Promise<string | null> {
    if (ref.kind === "movie") {
      const row = await this.db.one<{ file_id: string | null }>(
        `SELECT file_id FROM local_titles WHERE id = $1 AND media_type = 'movie'`,
        [ref.id],
      );
      return row?.file_id ?? null;
    }

    if (ref.kind === "episode") {
      const seasonRow = await this.db.one<{ id: string }>(
        `SELECT id FROM local_seasons WHERE title_id = $1 AND number = $2`,
        [ref.id, ref.season],
      );
      if (!seasonRow) return null;

      const episodeRow = await this.db.one<{ file_id: string | null }>(
        `SELECT file_id FROM local_episodes WHERE season_id = $1 AND number = $2`,
        [seasonRow.id, ref.episode],
      );
      return episodeRow?.file_id ?? null;
    }

    return null;
  }

  /**
   * A single server whose `src` is the `local_media_files.id` — an opaque
   * lookup key, not a URL, so it is never something `Core.resolveVideo`'s
   * SSRF check has to validate as fetchable.
   *
   * Empty list when the file isn't `ready` yet: a still-transcoding title
   * and an untouched one look identical to a client either way, matching
   * `TmdbProvider.getServers`'s "TMDB knows this title, nothing can play it
   * yet" case.
   */
  public override async getServers(id: string): Promise<VideoServer[]> {
    const ref = parseRef(id);
    if (!ref || (ref.kind !== "movie" && ref.kind !== "episode")) return [];

    const fileId = await this.fileIdFor(ref);
    if (!fileId) return [];

    const file = await this.db.one<{ status: string }>(
      `SELECT status FROM local_media_files WHERE id = $1`,
      [fileId],
    );
    if (!file || file.status !== "ready") return [];

    return [{ id: fileId, name: "Local", src: fileId }];
  }

  /**
   * Absolute, via `appBaseUrl()`, not a root-relative path — required for
   * `Core.resolveVideoUrl`'s `isValidUrl` check (which only accepts
   * `http(s)`/`#EXTM3U`), for the clients that have no page origin to
   * resolve a relative URL against (the Cast receiver, the app), and for a
   * path-prefixed install (`APP_URL = https://host/streamio`), whose reverse
   * proxy strips the prefix before it ever reaches this Express app: the URL
   * handed to a client has to carry the prefix itself, exactly like
   * `CAST_PUBLIC_BASE` in `content.router.ts`.
   *
   * The path lives under `/api` because a reverse proxy in front of an
   * install may only proxy that prefix and 302 everything else, and a 302
   * carries no CORS header — unfetchable from a page served off the proxy's
   * own origin. See the mount in `server.ts`.
   *
   * No `headers` to attach: this is our own origin, so there is nothing the
   * client needs `/api/cast-proxy` for.
   */
  public async getVideo(server: VideoServer): Promise<Video> {
    const fileId = server?.src?.trim();
    if (!fileId) throw new Error("Local provider: server has no file id");

    const file = await this.db.one<{ status: string }>(
      `SELECT status FROM local_media_files WHERE id = $1`,
      [fileId],
    );
    if (!file || file.status !== "ready") {
      throw new Error("Local provider: file is not ready to play");
    }

    return new Video(`${appBaseUrl()}/api/local-media/${fileId}/master.m3u8`);
  }
}

/**
 * The only family that can decline to register: without a `db` handle there is
 * no library to serve, so `create` returns null and the `local` slug simply
 * isn't in the registry — which is the state `core/test.ts` and the provider
 * smoke tests run in.
 */
export const providerFamily: ProviderModule = {
  order: 100,
  create: ({ db }) =>
    db
      ? {
          id: "local",
          displayName: "My Library",
          description: "Your own uploaded movies and shows.",
          // Its server `src` is a `local_media_files` id, not a URL — nothing
          // for `resolveVideo`'s SSRF check to validate as fetchable.
          resolve: (p, s) => (p as LocalProvider).getVideo(s),
          variants: [
            {
              slug: "local",
              language: "en",
              languageLabel: "—",
              instance: new LocalProvider(db),
            },
          ],
        }
      : null,
};
