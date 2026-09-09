/**
 * Everything a source publishes about a title that the flat `Movie`/`TvShow`
 * fields have no room for.
 *
 * Kept as one optional bag rather than more positional constructor arguments:
 * those constructors already take eighteen, every provider passes them
 * positionally, and a nineteenth would be a silent mis-assignment away from
 * every call site. `details` is assigned after construction and carried through
 * `copy()`; a provider that sets nothing leaves it `{}`.
 *
 * The whole object is serialized to clients as-is by `GET /api/shows/:id`, so
 * every field is optional and every consumer must treat a missing one as
 * "this source doesn't publish it" — never as a default.
 */

/** Ids on other catalogues, for cross-linking. All optional, all as published. */
export interface ExternalIds {
    imdb?: string;
    tmdb?: number | string;
    mal?: number | string;
    anilist?: number | string;
    netflix?: number | string;
    prime?: number | string;
    disney?: number | string;
    apple?: number | string;
    paramount?: number | string;
    hbo?: number | string;
    now?: number | string;
    crunchyroll?: number | string;
}

/** A labelled outbound link the source itself offers (MyAnimeList, AniList, …). */
export interface ExternalLink {
    label: string;
    url: string;
}

/** Which audio/subtitle tracks the source claims for a title. */
export interface AudioInfo {
    /** Italian dub available. */
    dubIta?: boolean;
    /** Italian subtitles available. */
    subIta?: boolean;
    /** Original-language audio available. */
    original?: boolean;
    /** Human label for the spoken language ("Giapponese"). */
    language?: string;
}

/** Popularity counters. Meaning differs per source; the labels do not. */
export interface ShowStats {
    /** Lifetime views/plays on the source. */
    views?: number;
    /** Views in the last day, where the source separates them. */
    dailyViews?: number;
    /** Users who favourited it. */
    favorites?: number;
    /** Users tracking it. */
    members?: number;
    /** How many votes the `rating` is an average of. */
    votes?: number;
}

export interface ShowDetails {
    /** Title in the original language, when it differs from `title`. */
    originalTitle?: string;
    /** Any further titles the source lists (romaji, native, alternate release). */
    alternativeTitles?: string[];
    /** Airing/production status, in the source's own words ("In corso"). */
    status?: string;
    /** Format, in the source's own words ("TV", "Movie", "OVA", "ONA"). */
    contentType?: string;
    /** Animation/production studio. */
    studio?: string;
    /** Broadcast season label ("Autunno 2002", "Estate 2026"). */
    seasonLabel?: string;
    /** Weekly release day, where the source schedules one. */
    airDay?: string;
    /** First release, ISO where the source gives one, else as published. */
    releaseDate?: string;
    /** Most recent episode's air date. */
    lastAirDate?: string;
    /** Total episodes the source claims — not the number it can play. */
    episodeCount?: number;
    /**
     * Number of the most recently published episode, where a listing says so
     * ("EP 21" on a latest-episodes rail). Distinct from `episodeCount`, which
     * is how many the season is expected to have.
     */
    latestEpisode?: number;
    /** Number of seasons the source lists. */
    seasonCount?: number;
    /** Per-episode runtime in minutes (distinct from a movie's `runtime`). */
    episodeRuntime?: number;
    /** Original language code, as published ("en", "ja"). */
    originalLanguage?: string;
    /** Maturity rating. A number is an age; a string is a certificate. */
    ageRating?: number | string;
    /** Free-text tags/keywords the source attaches to the title. */
    keywords?: string[];
    /** Transparent title-logo artwork, where the source ships one. */
    logo?: string;
    /** Muted looping preview clip (SC's `preview`), not the trailer. */
    previewUrl?: string;
    audio?: AudioInfo;
    stats?: ShowStats;
    externalIds?: ExternalIds;
    externalLinks?: ExternalLink[];
}
