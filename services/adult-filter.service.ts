// adult-filter.service.ts
//
// Removes 18+ items from a content response.
//
// These are deliberately plain functions over plain data, applied in
// content.router.ts *after* the platform handler returns — i.e. after the Redis
// cache. The cache stays global and unfiltered (keyed by provider only, see
// PlatformHandler), so there is no per-user cache bleed and no cache-key change.
//
// Which means everything here operates on JSON, not on `Movie`/`TvShow`
// instances: a cache hit deserializes to bare objects, so `adult` has to be read
// as a property and never as anything requiring the class.

/** An item is 18+ if the provider flagged it, or the denylist knows the id. */
export function isAdultItem(item: any, denylist: ReadonlySet<string>): boolean {
  if (!item) return false;
  return item.adult === true || (typeof item.id === "string" && denylist.has(item.id));
}

export function filterItems<T>(items: T[], denylist: ReadonlySet<string>): T[] {
  return items.filter((item) => !isAdultItem(item, denylist));
}

/**
 * Filters each rail's items and drops rails left empty — a home page with a
 * titled but empty row reads as broken.
 */
export function filterCategories<T extends { list?: any[] }>(
  categories: T[],
  denylist: ReadonlySet<string>
): T[] {
  if (!Array.isArray(categories)) return categories;

  return categories
    .map((category) => ({
      ...category,
      list: filterItems(category.list ?? [], denylist),
    }))
    .filter((category) => category.list.length > 0);
}
