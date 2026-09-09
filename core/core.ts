// core/Core.ts
import { providerModules } from "./providers/registry.js";
import type { Database } from "../database/db.js";
import {
  Movie,
  TvShow,
  Category,
  Episode,
  Genre,
  Provider,
  Video,
} from "./models/index.js";
import { supportsGenres } from "./models/Provider.js";
import type {
  ProviderVariant,
  ProviderFamily,
  ProviderContext,
} from "./models/ProviderRegistry.js";
import { assertFetchableUrl, looksLikeUrl } from "./utils/ssrf.js";

// The registry's own types live in `core/models/ProviderRegistry.ts`, not here:
// every provider file imports them to declare itself, and this module imports
// the provider files, so keeping them here would make the graph circular.
// Re-exported so existing consumers of `core.js` are unaffected.
export type {
  ProviderVariant,
  ProviderFamily,
  ProviderContext,
  ProviderModule,
} from "./models/ProviderRegistry.js";

/** Thrown by `Core` for a provider name that isn't in the registry. */
export class UnknownProviderError extends Error {
  constructor(public readonly providerName: string) {
    super(`Unknown provider "${providerName}"`);
    this.name = "UnknownProviderError";
  }
}

/** Thrown by `Core` for a provider name that is known but admin-disabled. */
export class ProviderDisabledError extends Error {
  constructor(public readonly providerName: string) {
    super(`Provider "${providerName}" is disabled`);
    this.name = "ProviderDisabledError";
  }
}

/** Thrown when a provider call is still pending past `PROVIDER_TIMEOUT_MS`. */
export class ProviderTimeoutError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly ms: number,
  ) {
    super(`Provider "${providerName}" timed out after ${ms}ms`);
    this.name = "ProviderTimeoutError";
  }
}

const PROVIDER_TIMEOUT_MS = 30_000;

/**
 * Bounds one provider call. A timeout becomes a rejection, never a resolved
 * value, so `WebPlatformHandler.withCache` can never persist it. This is the
 * only place every dispatch path funnels through (`getProvider()`'s callers
 * and `resolveVideo`'s own lookup), including direct `Core` consumers like
 * `tests/providers.test.mjs` that bypass `WebPlatformHandler` entirely — so a
 * future provider can't add an unbounded call by omission. Per-provider axios
 * timeouts remain as defense in depth, not the enforcement mechanism: without
 * them the underlying request keeps running after this race has already
 * rejected.
 */
function withTimeout<T>(
  promise: Promise<T>,
  providerName: string,
  ms = PROVIDER_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ProviderTimeoutError(providerName, ms)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** One selectable language of a source, as sent to clients. */
export type ProviderLanguageInfo = {
  /** Language code, e.g. `"it"`. */
  code: string;
  /** Human label, e.g. `"Italiano"`. */
  label: string;
  /** The concrete provider slug to send as `?provider=` for this language. */
  slug: string;
};

/**
 * The public shape of a registry entry — `getProviderCatalog()`'s element.
 *
 * Deliberately still **one entry per variant**, not per family: clients that
 * shipped before families existed render this list flat, and regrouping it
 * would have made a language variant disappear from their picker. `family` and
 * `languages` are additive — a client groups on `family` and renders a language
 * selector, or ignores both and gets exactly the list it got before.
 */
export type ProviderInfo = {
  name: string;
  displayName: string;
  description: string;
  adult: boolean;
  /** Family id shared by every language of this source. */
  family: string;
  /** This variant's language code. */
  language: string;
  /** Every language of the family, this one included. Never empty. */
  languages: ProviderLanguageInfo[];
};

/** `ProviderInfo` plus disabled state — the admin management view. */
export type AdminProviderInfo = ProviderInfo & { disabled: boolean };

export class Core {
  private families: ProviderFamily[] = [];
  /**
   * Flat slug → entry index. Every dispatch path is a slug lookup, so the flat
   * view is the hot one; it also keeps "the slug, not the family, is the wire
   * identity" explicit rather than buried in a nested scan.
   */
  private bySlug = new Map<
    string,
    { family: ProviderFamily; variant: ProviderVariant }
  >();
  private defaultProvider: Provider;

  /**
   * The registry is discovered, not written out here: every file in
   * `core/providers/` that exports a `providerFamily` descriptor is a source,
   * and `core/providers/registry.ts` has already imported and ordered them by
   * the time this module is evaluated. That is what keeps this constructor
   * synchronous — see the note on `providerModules`.
   *
   * `db` is optional, and exists only for `LocalProvider` — every other
   * provider scrapes a site or calls TMDB and has never needed a database
   * handle. A module whose `create` returns null for the context it is given
   * is left unregistered, which is how the `local` family is absent when a
   * `Core` is built without one (the ad hoc `core/test.ts` script, the
   * provider tests) — rather than forcing every caller of `Core` to supply a
   * `db` it has no use for.
   */
  constructor(db?: Database) {
    const ctx: ProviderContext = { db };

    this.families = providerModules
      .map((module) => module.create(ctx))
      .filter((family): family is ProviderFamily => family !== null);

    this.indexVariants();

    this.defaultProvider = this.families[0]?.variants[0]?.instance;
    if (!this.defaultProvider) {
      throw new Error("No providers available");
    }
  }

  /**
   * Builds the flat slug index and enforces the registry's invariants at boot.
   *
   * These throw rather than warn because every one of them is a bug that is
   * invisible at runtime: a provider whose `getName()` disagrees with its slug
   * stamps the wrong `providerName` onto every item it returns, and clients
   * hand that string straight back as `?provider=`. The checks matter more now
   * that a class receives its slug as an argument instead of hardcoding it —
   * a typo here is no longer a compile error anywhere.
   */
  private indexVariants() {
    for (const family of this.families) {
      if (!family.variants.length) {
        throw new Error(`Provider family "${family.id}" has no variants`);
      }

      if (family.variants[0].slug !== family.id) {
        throw new Error(
          `Provider family "${family.id}" must be named after its default ` +
            `variant (got "${family.variants[0].slug}")`,
        );
      }

      for (const variant of family.variants) {
        if (this.bySlug.has(variant.slug)) {
          throw new Error(`Duplicate provider slug "${variant.slug}"`);
        }

        if (variant.instance.getName() !== variant.slug) {
          throw new Error(
            `Provider "${variant.slug}" reports getName() === ` +
              `"${variant.instance.getName()}"; the two must match`,
          );
        }

        if (variant.instance.getLanguage() !== variant.language) {
          throw new Error(
            `Provider "${variant.slug}" is registered as ` +
              `"${variant.language}" but reports language ` +
              `"${variant.instance.getLanguage()}"`,
          );
        }

        this.bySlug.set(variant.slug, { family, variant });
      }
    }
  }

  /**
   * Every variant of every family, adult sources filtered unless asked for,
   * disabled variants always filtered — mirrors the adult filter, since a
   * disabled provider must disappear from every public listing/validation
   * the same way an adult one does when not asked for.
   */
  private listVariants(includeAdult: boolean) {
    return this.families
      .filter((f) => includeAdult || !f.adult)
      .flatMap((f) =>
        f.variants
          .filter((variant) => !variant.disabled)
          .map((variant) => ({ family: f, variant })),
      );
  }

  /** The family's languages, in registry order. */
  private languagesOf(family: ProviderFamily): ProviderLanguageInfo[] {
    return family.variants.map((v) => ({
      code: v.language,
      label: v.languageLabel,
      slug: v.slug,
    }));
  }

  /**
   * Throws on a name it doesn't know rather than falling back to the default
   * provider. The fallback made every "wrong provider name" bug look like an
   * empty catalogue: a request for one source was answered with another's
   * content, under the *asked-for* name, with nothing logged. Callers reaching
   * this from HTTP go through the routers' own validation first (see
   * `resolveProviderName` in `routes/content.router.ts`), so a throw here means
   * a caller inside the process got the name wrong.
   *
   * An empty name is still the default, which is the "no `?provider=` yet"
   * state the home page browses in before a source is picked.
   *
   * Routed through `bySlug` even for the default-name case so a disabled
   * default provider is rejected the same way a disabled named one is,
   * rather than silently serving anyway.
   */
  private getProvider(name: string): Provider {
    const slug = name || this.getDefaultProviderName();
    const entry = this.bySlug.get(slug);
    if (!entry) {
      throw new UnknownProviderError(name);
    }
    if (entry.variant.disabled) {
      throw new ProviderDisabledError(slug);
    }
    return entry.variant.instance;
  }

  /**
   * Every concrete variant slug — one per language, not one per source. This is
   * the list clients validate a stored selection against, so dropping a
   * language variant from it would make that language unselectable and would
   * silently reset anyone already on it.
   *
   * Adult providers are omitted unless asked for, so a caller that forgets to
   * thread the user's 18+ preference through leaks nothing.
   */
  public getListOfProviders(includeAdult: boolean = false): string[] {
    return this.listVariants(includeAdult).map((e) => e.variant.slug);
  }

  /**
   * The same list as `getListOfProviders()` (same order, same 18+ filtering)
   * with the display metadata attached, so a client can render a source picker
   * without knowing any provider name in advance.
   *
   * Still flat, one entry per language variant — see `ProviderInfo`. The
   * grouped view is `getProviderFamilies()`.
   */
  public getProviderCatalog(includeAdult: boolean = false): ProviderInfo[] {
    return this.listVariants(includeAdult).map(({ family, variant }) =>
      this.toProviderInfo(family, variant),
    );
  }

  private toProviderInfo(
    family: ProviderFamily,
    variant: ProviderVariant,
  ): ProviderInfo {
    return {
      name: variant.slug,
      displayName:
        variant.legacyDisplayName ??
        (variant.slug === family.id
          ? family.displayName
          : `${family.displayName} (${variant.languageLabel})`),
      description: family.description,
      adult: family.adult === true,
      family: family.id,
      language: variant.language,
      languages: this.languagesOf(family),
    };
  }

  /**
   * Every variant, adult and disabled included — admin management UI only.
   * Never used to answer a non-admin client; see `getProviderCatalog()` for
   * that.
   */
  public getAdminProviderCatalog(): AdminProviderInfo[] {
    return this.families.flatMap((family) =>
      family.variants.map((variant) => ({
        ...this.toProviderInfo(family, variant),
        disabled: variant.disabled === true,
      })),
    );
  }

  public setProviderDisabled(slug: string, disabled: boolean): void {
    const entry = this.bySlug.get(slug);
    if (!entry) {
      throw new UnknownProviderError(slug);
    }
    entry.variant.disabled = disabled;
  }

  public isProviderDisabled(slug: string): boolean {
    return this.bySlug.get(slug)?.variant.disabled === true;
  }

  /**
   * Boot-time bulk apply from persisted settings. Unknown slugs are logged
   * and ignored rather than thrown — a stale slug for a since-removed
   * provider must not stop the server from starting.
   */
  public loadDisabledProviders(slugs: string[]): void {
    for (const slug of slugs) {
      const entry = this.bySlug.get(slug);
      if (entry) {
        entry.variant.disabled = true;
      } else {
        console.warn(`disabled_providers: unknown slug "${slug}", ignoring`);
      }
    }
  }

  /**
   * Unlike the internal `getProvider`, this does not fall back to the default
   * provider — callers that need to know whether a name is real (rather than
   * just get something to call) must be able to tell.
   */
  public getProviderByName(name: string): Provider | undefined {
    return this.bySlug.get(name)?.variant.instance;
  }

  public isAdultProvider(name: string): boolean {
    return this.bySlug.get(name)?.family.adult === true;
  }

  public getDefaultProvider(): Provider {
    return this.defaultProvider;
  }

  /**
   * The default provider's *registry slug* — what a caller passes back in as
   * `?provider=`. Read this rather than `getDefaultProvider().getName()`: the
   * two agree today only because every provider is constructed with its own
   * slug, and the registry entry is the authority on that.
   */
  public getDefaultProviderName(): string {
    return this.families[0].variants[0].slug;
  }

  async getHome(providerName: string): Promise<Category[]> {
    const provider = this.getProvider(providerName);
    return await withTimeout(provider.getHome(), providerName);
  }

  async search(
    providerName: string,
    query: string,
    page = 1,
  ): Promise<(Movie | TvShow)[]> {
    const provider = this.getProvider(providerName);
    const results = await withTimeout(provider.search(query, page), providerName);

    type SearchResult = Movie | TvShow;
    const typedResults: unknown[] = results as unknown[];

    return typedResults.filter(
      (r: unknown): r is SearchResult =>
        r instanceof Movie || r instanceof TvShow,
    );
  }

  async getShowDetails(
    providerName: string,
    showId: string,
  ): Promise<TvShow | Movie | null> {
    const provider = this.getProvider(providerName) as any;

    // The two probes are a guess about which kind of thing this id is, so
    // neither one throwing is conclusive on its own. A films-only source
    // answers `getTvShow` by throwing — the base `Provider` does exactly that
    // for any method a provider leaves unimplemented — and letting that escape
    // turns every detail request into a 500 before the movie probe ever runs.
    // The first failure is kept and rethrown only if the other probe has
    // nothing either, so a genuinely broken parser still surfaces its own
    // error rather than a bare 404.
    let failure: unknown;

    if (typeof provider.getTvShow === "function") {
      try {
        const result = (await withTimeout(
          provider.getTvShow(showId),
          providerName,
        )) as TvShow | null;
        if (result && result.title) return result;
      } catch (e) {
        failure = e;
      }
    }

    if (typeof provider.getMovie === "function") {
      try {
        const result = (await withTimeout(
          provider.getMovie(showId),
          providerName,
        )) as Movie | null;
        if (result && result.title) return result;
      } catch (e) {
        failure ??= e;
      }
    }

    if (failure) throw failure;

    return null;
  }

  async getEpisodes(
    providerName: string,
    seasonId: string,
  ): Promise<Episode[]> {
    const provider = this.getProvider(providerName);
    return (await withTimeout(
      provider.getEpisodesBySeason(seasonId),
      providerName,
    )) as unknown as Episode[];
  }

  async getServers(
    providerName: string,
    episodeId: string,
    _contentType?: "episode" | "movie",
  ) {
    const provider = this.getProvider(providerName);
    return await withTimeout(provider.getServers(episodeId), providerName);
  }

  /**
   * Resolution is a registry capability: a family declares a `resolve` hook
   * or video resolution isn't supported for it. There is no generic
   * fallback extractor — the one that used to exist here (Vixcloud) only
   * ever served scraped sources, and the only family left (`local`) always
   * declares its own `resolve`.
   */
  async resolveVideo(providerName: string, server: any): Promise<Video> {
    const slug = providerName || this.getDefaultProviderName();
    const entry = this.bySlug.get(slug);
    if (!entry) {
      throw new UnknownProviderError(providerName);
    }
    if (entry.variant.disabled) {
      throw new ProviderDisabledError(slug);
    }

    const { family, variant } = entry;

    const serverSrc = typeof server?.src === "string" ? server.src.trim() : "";

    // `server` is whatever the client POSTed, and `family.resolve` below
    // turns `src` into an HTTP request from inside the container — so a URL
    // that points at localhost, the compose network, or the cloud metadata
    // service must never reach one. `content.router.ts` checks the same
    // thing at the route; this is the layer for callers that reach `Core`
    // without going through the router at all (the provider tests today, a
    // new route tomorrow).
    if (serverSrc && looksLikeUrl(serverSrc)) {
      await assertFetchableUrl(serverSrc);
    }

    if (family.resolve) {
      return (await withTimeout(
        family.resolve(variant.instance, server),
        slug,
      )) as Video;
    }

    throw new Error(
      `Provider "${providerName}" does not support video resolution`,
    );
  }

  async resolveVideoUrl(providerName: string, server: any): Promise<string> {
    const video = await this.resolveVideo(providerName, server);

    const raw = (video as any).playlistUrl ?? (video as any).source;
    const url = this.normalizeHls(raw);

    if (!this.isValidUrl(url)) {
      throw new Error("Invalid HLS URL: " + url);
    }

    return url;
  }

  private normalizeHls(input: string): string {
    if (!input) throw new Error("Empty URL");

    if (input.startsWith("data:")) {
      const base64 = input.split(",")[1];
      if (!base64) throw new Error("Invalid data URL");

      return Buffer.from(base64, "base64").toString("utf-8");
    }

    return input.trim();
  }

  private isValidUrl(url: string): boolean {
    return (
      Boolean(url) &&
      !url.includes("undefined") &&
      (url.startsWith("http") ||
        url.startsWith("https") ||
        url.startsWith("#EXTM3U"))
    );
  }

  /** True when the provider can list genres and browse titles within one. */
  public supportsGenres(providerName: string): boolean {
    return supportsGenres(this.getProvider(providerName));
  }

  async getGenres(providerName: string): Promise<Genre[]> {
    const provider = this.getProvider(providerName);

    if (supportsGenres(provider)) {
      return await withTimeout(provider.getGenres(), providerName);
    }

    // A provider that predates the genre contract may still answer an empty
    // search with its catalogue, which is what it used to mean.
    const results = await withTimeout(provider.search("", 1), providerName);
    const genres = (results as unknown[]).filter(
      (r): r is Genre => r instanceof Genre,
    );

    if (genres.length) return genres;

    throw new Error(
      `Provider "${providerName}" does not support genre retrieval`,
    );
  }

  /** One page of titles within a genre. */
  async getGenre(
    providerName: string,
    genreId: string,
    page = 1,
  ): Promise<Genre> {
    const provider = this.getProvider(providerName);

    if (!supportsGenres(provider)) {
      throw new Error(
        `Provider "${providerName}" does not support genre browsing`,
      );
    }

    return await withTimeout(provider.getGenre(genreId, page), providerName);
  }
}
