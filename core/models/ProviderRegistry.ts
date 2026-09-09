// core/models/ProviderRegistry.ts
//
// The shape of a registry entry, and the descriptor a provider file exports to
// register itself.
//
// These types live here rather than in `core/core.ts` because every provider
// file imports them: keeping them in `core.ts` — which imports the discovered
// provider modules — would make the graph circular.
import type { Database } from "../../database/db.js";
import type { Provider } from "./Provider.js";
import type { Video } from "./Video.js";

/**
 * One language of one source.
 *
 * The variant — not the family — is the wire identity: `slug` is what a client
 * sends as `?provider=`, what lands in every item's `providerName`, what keys
 * the response cache in `PlatformHandler`, and what is stored in the
 * `provider` column of watchlist/favorites/ratings/history/shares/rooms rows.
 * Grouping variants under a family is a presentation concern and must never
 * change any of that.
 */
export type ProviderVariant = {
  /** Wire slug. Must equal `instance.getName()` — checked at boot. */
  slug: string;
  /** Language code. Must equal `instance.getLanguage()` — checked at boot. */
  language: string;
  /** Human label for the language picker, server-owned like `displayName`. */
  languageLabel: string;
  /**
   * Overrides the label this variant is given in the flat `getProviderCatalog()`
   * view. Only needed to keep a name that shipped before families existed
   * byte-identical for clients that render that list ungrouped.
   */
  legacyDisplayName?: string;
  /**
   * Runtime-mutable, unlike every other field on this type (those are boot-time
   * invariants). Set only via `Core.setProviderDisabled`/`loadDisabledProviders`,
   * never at registration — an admin toggle, not a source characteristic.
   */
  disabled?: boolean;
  instance: Provider;
};

/**
 * One source, in every language it is available in.
 *
 * A family exists because a multi-language site is the same site with a
 * locale prefix: one provider class, instantiated once per language, rather
 * than a copied class per mirror. Everything here is language-independent by
 * definition — if a field would have to differ per variant, it belongs on the
 * variant instead.
 */
export type ProviderFamily = {
  /** Family id. Equals `variants[0].slug`, so it is also a usable provider name. */
  id: string;
  /**
   * How the name is written for a human — the internal names are lowercase and
   * unspaced, so capitalizing one gives things like "Localprovider". Lives here
   * rather than in each client because every client needs the same string, and
   * a client that hardcodes it can't label a provider added server-side.
   * Carries no language: that is what `ProviderVariant.languageLabel` is for.
   */
  displayName: string;
  /** One line introducing the source, same rationale as `displayName`. */
  description: string;
  /**
   * Whole-provider 18+ source. Hidden from `getListOfProviders()` unless the
   * caller explicitly asks for adult providers; the routers reject content
   * requests for one outright, ahead of dispatch.
   */
  adult?: boolean;
  /**
   * How a raw server entry becomes a playable `Video`. A family without this
   * has no way to resolve video at all — see `resolveVideo` in `core/core.ts`.
   * This is a registry capability rather than a chain of `if (providerName ===
   * "...")` comparisons, which is what let a source with no branch silently
   * degrade to a wrong extractor with nothing logged.
   */
  resolve?: (instance: Provider, server: any) => Promise<Video>;
  /** At least one. `variants[0]` is the family's default language. */
  variants: ProviderVariant[];
};

/**
 * What a provider module may need in order to construct itself.
 *
 * `db` exists only for `LocalProvider` — every other provider scrapes a site or
 * calls TMDB and has never needed a database handle. A `Core` built without one
 * (the ad hoc `core/test.ts` script, `tests/providers.test.mjs`) simply doesn't
 * register the families that require it.
 */
export type ProviderContext = { db?: Database };

/**
 * What a file in `core/providers/` exports to be registered.
 *
 * Discovery (`core/providers/registry.ts`) imports every module in that
 * directory and picks up whatever exports `providerFamily`. A file without the
 * export is not a provider — that is what would keep a shared helper module
 * placed alongside the providers out of the registry, or let a provider class
 * be implemented but deliberately left unregistered.
 */
export type ProviderModule = {
  /**
   * Registration order, ascending. This is not cosmetic: the first family's
   * first variant is the default provider, and the order is what every client's
   * source picker renders, so it must be explicit rather than whatever order
   * `readdir` happens to return. Must be unique across all modules — a tie
   * would silently decide the default provider by filename, so it throws at
   * boot instead. Values are spaced by ten so a new source can be slotted
   * between two existing ones without renumbering.
   */
  order: number;
  /**
   * Returns null when a dependency this source needs is absent, in which case
   * the family is simply not registered. Constructed at boot, before
   * migrations have run (see `server.ts`'s constructor comment), so this must
   * never read the database — only pass the handle along.
   */
  create(ctx: ProviderContext): ProviderFamily | null;
};
