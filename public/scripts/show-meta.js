/**
 * The one-line summary printed under a card's title on the home, catalog and
 * search grids.
 *
 * It used to be `genre || runtime || "—"`, which meant an em dash on almost
 * every card: listings carry neither field on most providers. The real data —
 * format, year, season/episode counts, status — arrives in `item.details`
 * (the provider's `ShowDetails`, see core/models/ShowDetails.ts), which the
 * grids were ignoring entirely.
 *
 * Rules that matter here:
 *  - **Never invent a placeholder.** An item with nothing to say gets "", and
 *    the caller drops the element rather than printing a dash.
 *  - Absence in `details` means "this source doesn't publish it", never a
 *    default, so every read is guarded.
 *  - Cards are narrow. At most three parts, most identifying first.
 */

/** Only a TvShow serializes a `seasons` array; Movie has no such field. */
export function isSeries(item) {
  return Array.isArray(item?.seasons);
}

/** Four-digit year out of an ISO date, a Date string, or a bare year. */
function year(value) {
  if (!value) return null;
  const match = String(value).match(/\b(\d{4})\b/);
  return match ? match[1] : null;
}

/**
 * The format label. Providers spell it in their own words — SC says
 * "Film"/"Serie TV", the anime sources say "TV"/"OVA"/"ONA"/"Movie" — and
 * that word is more informative than a normalised "Series", so it is kept
 * as published. Only when no source published one do we fall back to the
 * structural guess.
 */
function kindLabel(item) {
  const published = item?.details?.contentType;
  if (published) return published;
  return isSeries(item) ? "Serie" : "Film";
}

/**
 * Parts in priority order, deduped and capped. `limit` exists because the
 * poster overlay has less room than the card body under it.
 */
export function showMetaParts(item, limit = 3) {
  if (!item) return [];
  const d = item.details || {};
  const parts = [];

  parts.push(kindLabel(item));

  const released = year(d.releaseDate) || year(item.released);
  if (released) parts.push(released);

  // Episode counters only mean something for a series, and the most recent
  // episode is the more useful of the two on a "latest episodes" rail.
  if (d.latestEpisode) {
    parts.push(`Ep ${d.latestEpisode}`);
  } else if (d.episodeCount) {
    parts.push(`${d.episodeCount} ep`);
  } else if (d.seasonCount) {
    parts.push(d.seasonCount === 1 ? "1 stagione" : `${d.seasonCount} stagioni`);
  }

  if (item.runtime) parts.push(`${item.runtime} min`);
  if (item.quality) parts.push(item.quality);
  if (d.status) parts.push(d.status);
  if (d.studio) parts.push(d.studio);
  if (item.genres?.[0]?.name) parts.push(item.genres[0].name);

  return [...new Set(parts.filter(Boolean).map(String))].slice(0, limit);
}

/**
 * Ready-to-print meta line, or "" when the item carries nothing. Callers must
 * escape the result themselves — this module has no DOM dependency so it can
 * be imported by any page.
 */
export function showMeta(item, limit = 3) {
  return showMetaParts(item, limit).join(" · ");
}

// ── Fatti del titolo (watch + details) ───────────────────────
// The two pages render the same facts in different markup — a chip strip on
// the watch page, a two-column table on the details page — so what the facts
// *are* lives here and only the markup lives in the pages. Adding a field to
// `ShowDetails` means touching this list once.

const AUDIO_LABELS = {
  dubIta: "Doppiaggio ITA",
  subIta: "Sottotitoli ITA",
  original: "Audio originale",
};

export const STAT_LABELS = {
  views: "Visualizzazioni",
  dailyViews: "Visite oggi",
  favorites: "Preferiti",
  members: "Follower",
  votes: "Voti",
};

export function formatNumber(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("it-IT") : null;
}

/**
 * Sources publish dates in whatever shape they store them: a full ISO day, a
 * bare year, or already-formatted text. Only the first is worth reformatting —
 * the rest is printed as published rather than guessed at.
 */
export function formatDate(value) {
  if (!value) return null;
  const iso = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return String(value);
  const d = new Date(`${iso[0]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("it-IT", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Maturity rating as a label: a number is an age, a string a certificate. */
export function ageLabel(ageRating) {
  if (ageRating == null || ageRating === "") return null;
  return typeof ageRating === "number" ? `${ageRating}+` : String(ageRating);
}

/** The audio/subtitle tracks a source claims, as one line. */
export function audioLabel(details = {}) {
  const tracks = Object.entries(AUDIO_LABELS)
    .filter(([key]) => details.audio?.[key])
    .map(([, label]) => label);
  if (details.audio?.language) tracks.push(details.audio.language);
  return tracks.join(" · ") || null;
}

/**
 * Ordered `{label, value}` facts, skipping everything the source didn't
 * publish. Plain strings only — anything that needs markup (genre links,
 * keyword chips, outbound links) stays with the page that renders it.
 */
export function showFacts(item) {
  if (!item) return [];
  const d = item.details || {};

  const released = formatDate(d.releaseDate) || formatDate(String(item.released || "").slice(0, 10));

  const facts = [
    ["Titolo orig.", d.originalTitle],
    ["Tipo", d.contentType],
    ["Stato", d.status],
    ["Uscita", released],
    ["Ultimo ep.", formatDate(d.lastAirDate)],
    ["Stagione", d.seasonLabel],
    ["In onda", d.airDay],
    ["Episodi", formatNumber(d.episodeCount)],
    ["Ultimo episodio", d.latestEpisode ? `Ep ${d.latestEpisode}` : null],
    ["Stagioni", formatNumber(d.seasonCount)],
    ["Durata", item.runtime ? `${item.runtime} min` : null],
    // Per-episode runtime only earns a row when it isn't already `runtime`.
    ["Durata ep.", d.episodeRuntime && d.episodeRuntime !== item.runtime ? `${d.episodeRuntime} min` : null],
    ["Studio", d.studio],
    ["Lingua orig.", d.originalLanguage],
    ["Audio", audioLabel(d)],
    ["Età", ageLabel(d.ageRating)],
    ["Qualità", item.quality],
  ];

  return facts
    .filter(([, value]) => value != null && value !== "")
    .map(([label, value]) => ({ label, value: String(value) }));
}
