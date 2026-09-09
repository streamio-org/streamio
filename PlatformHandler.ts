import { PlatformHandler } from "./core/models/PlatformHandler.js";
import { Database } from "./database/db.js";
import { Redis } from "./database/redis.js";
import type { Genre } from "./core/models/index.js";

export class WebPlatformHandler extends PlatformHandler {
  db: Database;
  redis: Redis;
  ready: boolean = false;

  // TTLs in seconds
  private static readonly TTL = {
    HOME: 60 * 10,         // 10 min — home change occasionally
    SEARCH: 60 * 60,      // 1 hr — search results don't change often for the same query
    SHOW_DETAILS: 60 * 60,// 1 hr — show details don't change often
    EPISODES: 60 * 10,    // 10 min — episode lists can change with new releases
    SERVERS: 60 * 2,      // 2 min — server lists can rotate quickly
    VIDEO: 60 * 1,        // 1 min — resolved URLs often expire fast
    GENRES: 60 * 60 * 6,  // 6 hr — a site's genre catalogue is near-static
    GENRE: 60 * 30,       // 30 min — a genre's titles change with new releases
  } as const;

  // A successful-but-empty result gets this short TTL instead of the
  // endpoint's usual one. A struggling provider that resolves empty (rather
  // than rejecting — see core/core.ts's timeout/rethrow handling for the
  // rejection path) would otherwise poison the cache for everyone until the
  // full TTL expires; 30s lets a real recovery or a legitimately-empty
  // result self-heal fast without hammering the upstream on every request.
  private static readonly EMPTY_TTL = 30;

  private static isEmptyResult(result: unknown): boolean {
    if (Array.isArray(result)) return result.length === 0;
    return !result;
  }

  constructor(db: Database, redis: Redis) {
    super("web", db);
    this.db = db;
    this.redis = redis;
    this.ready = true;
  }

  async close() {
    await this.redis.close();
    await this.db.close?.();
    this.ready = false;
  }

  private ensureReady() {
    if (!this.ready) {
      throw new Error("WebPlatformHandler not initialized. Call init() first.");
    }
  }

  private async withCache<T>(
    key: string,
    ttl: number,
    fn: () => Promise<T>,
    isEmpty: (result: T) => boolean = WebPlatformHandler.isEmptyResult,
    skipCache = false
  ): Promise<T> {
    if (!skipCache) {
      const cached = await this.redis.get<T>(key);
      if (cached !== null && cached !== undefined) return cached;
    }

    const result = await fn();
    await this.redis.set(key, result, isEmpty(result) ? WebPlatformHandler.EMPTY_TTL : ttl);
    return result;
  }

  /**
   * Deletes every cache entry for one provider. Cache keys always carry the
   * provider slug as their second segment (see the `key` construction in
   * each method below), never as a leading, single greppable prefix, so this
   * has to cover each endpoint's own pattern rather than one SCAN.
   */
  async clearProviderCache(providerName: string): Promise<number> {
    this.ensureReady();
    const patterns = [
      `home:${providerName}`,
      `search:${providerName}:*`,
      `show:${providerName}:*`,
      `episodes:${providerName}:*`,
      `servers:${providerName}:*`,
      `genres:${providerName}`,
      `genre:${providerName}:*`,
      `video:${providerName}:*`,
    ];
    let total = 0;
    for (const pattern of patterns) {
      total += await this.redis.deleteByPattern(pattern);
    }
    return total;
  }

  override async getHome(providerName: string) {
    this.ensureReady();

    const key = `home:${providerName}`;
    return this.withCache(key, WebPlatformHandler.TTL.HOME, () =>
      this.core.getHome(providerName)
    );
  }

  override async search(providerName: string, query: string, page?: number) {
    this.ensureReady();

    const key = `search:${providerName}:${query}:${page ?? 1}`;
    const result = await this.withCache(key, WebPlatformHandler.TTL.SEARCH, () =>
      this.core.search(providerName, query, page)
    );

    await this.db
      .query(
        `INSERT INTO search_logs (provider, query, page) VALUES ($1, $2, $3)`,
        [providerName, query, page ?? 1]
      )
      .catch(() => {});

    return result;
  }

  override async getShowDetails(providerName: string, showId: string) {
    this.ensureReady();

    const key = `show:${providerName}:${showId}`;
    return this.withCache(key, WebPlatformHandler.TTL.SHOW_DETAILS, () =>
      this.core.getShowDetails(providerName, showId)
    );
  }

  override async getEpisodes(providerName: string, seasonId: string) {
    this.ensureReady();

    const key = `episodes:${providerName}:${seasonId}`;
    return this.withCache(key, WebPlatformHandler.TTL.EPISODES, () =>
      this.core.getEpisodes(providerName, seasonId)
    );
  }

  override async getServers(
    providerName: string,
    episodeId: string,
    contentType?: "episode" | "movie"
  ) {
    this.ensureReady();

    const key = `servers:${providerName}:${episodeId}:${contentType ?? "episode"}`;
    return this.withCache(key, WebPlatformHandler.TTL.SERVERS, () =>
      this.core.getServers(providerName, episodeId, contentType)
    );
  }

  async getGenres(providerName: string) {
    this.ensureReady();

    const key = `genres:${providerName}`;
    return this.withCache(key, WebPlatformHandler.TTL.GENRES, () =>
      this.core.getGenres(providerName)
    );
  }

  supportsGenres(providerName: string) {
    return this.core.supportsGenres(providerName);
  }

  async getGenre(providerName: string, genreId: string, page?: number) {
    this.ensureReady();

    const key = `genre:${providerName}:${genreId}:${page ?? 1}`;
    // Genre is a single object ({..., shows: Show[]}), always truthy, so the
    // default array/falsy predicate would never flag an empty page as empty.
    return this.withCache(
      key,
      WebPlatformHandler.TTL.GENRE,
      () => this.core.getGenre(providerName, genreId, page),
      (r: Genre) => !r || !r.shows?.length
    );
  }

  // `fresh` skips the cached URL entirely — used when a client already tried
  // the cached resolve and it played back a broken/wrong stream: a plain
  // retry within the TTL window would just hand back the same bad cached
  // URL, so the client has to ask for a re-resolve explicitly.
  async resolveVideo(providerName: string, server: any, fresh = false) {
    this.ensureReady();

    const serverKey = typeof server === "object"
      ? JSON.stringify(server)
      : String(server);
    const key = `video:${providerName}:${Buffer.from(serverKey).toString("base64")}`;

    return this.withCache(
      key,
      WebPlatformHandler.TTL.VIDEO,
      () => this.core.resolveVideo(providerName, server),
      WebPlatformHandler.isEmptyResult,
      fresh
    );
  }
}