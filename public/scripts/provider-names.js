/**
 * Display metadata for the content providers.
 *
 * Shared because the home chips and the /providers cards both label the same
 * list. Only `local` (the user's own uploaded library) is registered — this
 * fallback copy exists for the same reason it always did (the frontend ships
 * with the server and can't fall out of step with the registry), not because
 * more than one entry is expected here.
 */
export const displayNames = {
  local: "My Library",
};

export const descriptions = {
  local: "Your own uploaded movies and shows",
};

/**
 * Providers the server only lists once the `adult_content` preference is on —
 * used purely to badge them in the UI. The gate itself is server-side; an
 * entry missing here changes nothing about what is served. `local` is never
 * a whole-provider adult source — its titles are gated individually by their
 * own `adult` flag.
 */
export const adultProviders = new Set([]);

export function getName(p) {
  return displayNames[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

export function getDesc(p) {
  return descriptions[p] || "Streaming content source";
}

export function isAdultProvider(p) {
  return adultProviders.has(p);
}

/**
 * Fallback label for a language code. The server sends a `label` with every
 * language it offers; this only covers an install that predates that field.
 */
const languageNames = {
  it: "Italiano",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  "es-mx": "Español (México)",
  "es-ar": "Español (Argentina)",
  pl: "Polski",
};

export function getLanguageLabel(code) {
  if (!code) return "";
  return languageNames[code] || code.toUpperCase();
}

/**
 * Groups the server's flat provider `catalog` into one entry per source, with
 * the languages it is available in.
 *
 * The catalog is deliberately flat — one entry per language variant — because
 * clients that predate provider families render it as-is. Everything that
 * shows a picker groups it here instead, so a source with two languages is one
 * card plus a language selector rather than two unrelated-looking sources.
 *
 * Languages are built from the catalog entries themselves rather than from an
 * entry's `languages` array, so the picker can never offer a slug the visitor
 * isn't allowed to select. Passing plain `{ name }` objects (all an old install
 * can give us) yields one single-language family each, which renders exactly as
 * the ungrouped list did.
 */
export function groupFamilies(catalog = []) {
  const families = [];
  const byId = new Map();

  for (const entry of catalog) {
    const id = entry.family || entry.name;
    let family = byId.get(id);

    if (!family) {
      family = {
        id,
        displayName: "",
        description: entry.description || getDesc(entry.name),
        adult: false,
        languages: [],
      };
      byId.set(id, family);
      families.push(family);
    }

    if (entry.adult ?? isAdultProvider(entry.name)) family.adult = true;

    // The family is named after its default variant — the one whose slug is
    // the family id. Until that one is seen, any variant's label beats none.
    if (!family.displayName || entry.name === id) {
      family.displayName = entry.displayName || getName(entry.name);
    }

    const meta = (entry.languages || []).find((l) => l.slug === entry.name);
    family.languages.push({
      code: entry.language || meta?.code || "",
      label: meta?.label || getLanguageLabel(entry.language),
      slug: entry.name,
    });
  }

  return families;
}
