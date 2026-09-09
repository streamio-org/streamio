import axios, { AxiosInstance } from "axios";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({
  path: path.resolve(moduleDir, "../../../.env"),
});

type Range<T> = { gte?: T; lte?: T };

function filterParams(params: Record<string, any>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([_, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)])
  );
}

class Api {
  private static client: AxiosInstance = axios.create({
    baseURL: "https://api.themoviedb.org/3/",
    timeout: 25_000,
    params: {
      api_key: process.env.TMDB_API_KEY,
    },
  });

  static getClient() {
    return this.client;
  }
}

export const TMDb3 = {
  // =========================
  // DISCOVER
  // =========================
  Discover: {
    movie: async (params: any) => {
      const query = filterParams({
        certification: params?.certification,
        include_adult: params?.includeAdult,
        include_video: params?.includeVideo,
        language: params?.language,
        page: params?.page,
        primary_release_year: params?.primaryReleaseYear,
        region: params?.region,
        sort_by: params?.sortBy,
        "vote_average.gte": params?.voteAverage?.gte,
        "vote_average.lte": params?.voteAverage?.lte,
        "vote_count.gte": params?.voteCount?.gte,
        "vote_count.lte": params?.voteCount?.lte,
        year: params?.year,
        // Filters below are `|`-joined for OR / `,`-joined for AND by the
        // caller — TMDB reads the separator, so they are passed through as
        // already-built strings.
        with_genres: params?.withGenres,
        with_keywords: params?.withKeywords,
        with_watch_providers: params?.withWatchProviders,
        watch_region: params?.watchRegion,
        with_original_language: params?.withOriginalLanguage,
      });

      const res = await Api.getClient().get("discover/movie", { params: query });
      return res.data;
    },

    tv: async (params: any) => {
      const query = filterParams({
        language: params?.language,
        page: params?.page,
        sort_by: params?.sortBy,
        "vote_average.gte": params?.voteAverage?.gte,
        "vote_average.lte": params?.voteAverage?.lte,
        with_genres: params?.withGenres,
        with_keywords: params?.withKeywords,
        with_networks: params?.withNetworks,
        with_watch_providers: params?.withWatchProviders,
        watch_region: params?.watchRegion,
        with_original_language: params?.withOriginalLanguage,
      });

      const res = await Api.getClient().get("discover/tv", { params: query });
      return res.data;
    },
  },

  // =========================
  // GENRES
  // =========================
  Genres: {
    movieList: async (params?: { language?: string }) => {
      const res = await Api.getClient().get("genre/movie/list", {
        params: filterParams({ language: params?.language }),
      });
      return res.data;
    },

    tvList: async (params?: { language?: string }) => {
      const res = await Api.getClient().get("genre/tv/list", {
        params: filterParams({ language: params?.language }),
      });
      return res.data;
    },
  },

  // =========================
  // MOVIES
  // =========================
  Movies: {
    details: async (
      movieId: number,
      params?: { language?: string; appendToResponse?: string[] }
    ) => {
      const query = filterParams({
        language: params?.language,
        append_to_response: params?.appendToResponse?.join(","),
      });

      const res = await Api.getClient().get(`movie/${movieId}`, {
        params: query,
      });
      return res.data;
    },
  },

  MovieLists: {
    popular: async (params?: any) => {
      const res = await Api.getClient().get("movie/popular", {
        params: filterParams(params || {}),
      });
      return res.data;
    },

    topRated: async (params?: any) => {
      const res = await Api.getClient().get("movie/top_rated", {
        params: filterParams(params || {}),
      });
      return res.data;
    },
  },

  // =========================
  // TV
  // =========================
  TvSeries: {
    details: async (
      seriesId: number,
      params?: { language?: string; appendToResponse?: string[] }
    ) => {
      const query = filterParams({
        language: params?.language,
        append_to_response: params?.appendToResponse?.join(","),
      });

      const res = await Api.getClient().get(`tv/${seriesId}`, {
        params: query,
      });
      return res.data;
    },
  },

  TvSeriesLists: {
    airingToday: async (params?: any) => {
      const res = await Api.getClient().get("tv/airing_today", {
        params: filterParams(params || {}),
      });
      return res.data;
    },

    popular: async (params?: any) => {
      const res = await Api.getClient().get("tv/popular", {
        params: filterParams(params || {}),
      });
      return res.data;
    },

    topRated: async (params?: any) => {
      const res = await Api.getClient().get("tv/top_rated", {
        params: filterParams(params || {}),
      });
      return res.data;
    },
  },

  TvSeasons: {
    details: async (
        seriesId: number,
        seasonNumber: number,
        params?: { language?: string; appendToResponse?: string[] }
    ) => {
        const res = await Api.getClient().get(
        `tv/${seriesId}/season/${seasonNumber}`,
        {
            params: filterParams({
            language: params?.language,
            append_to_response: params?.appendToResponse?.join(","),
            }),
        }
        );

        return res.data;
    },
    },

  // =========================
  // SEARCH
  // =========================
  Search: {
    multi: async (
      queryStr: string,
      params?: { includeAdult?: boolean; language?: string; page?: number }
    ) => {
      const res = await Api.getClient().get("search/multi", {
        params: filterParams({
          query: queryStr,
          include_adult: params?.includeAdult,
          language: params?.language,
          page: params?.page,
        }),
      });

      return res.data;
    },
  },

  // =========================
  // TRENDING
  // =========================
  Trending: {
    all: async (
      timeWindow: "day" | "week",
      params?: { language?: string; page?: number }
    ) => {
      const res = await Api.getClient().get(`trending/all/${timeWindow}`, {
        params: filterParams(params || {}),
      });

      return res.data;
    },
  },
};