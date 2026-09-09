// adult.service.ts
//
// Resolves the 18+ gate for the content router, from a plain boolean
// preference in `user_preferences` (see account.service.ts) that the user
// creates by hand from Account → Preferences.
//
// Anonymous callers are always refused. The content routes are unauthenticated
// by design (optionalAuth, not requireAuth), so "no user" is the common case and
// has to be the safe one.
import type { Database } from "../database/db.js";
import type { Redis } from "../database/redis.js";

export const ADULT_PREFERENCE_KEY = "adult_content";

const CACHE_PREFIX = "adultpref:";
// Short: every content request asks, and the preference is busted explicitly on
// write, so this only bounds the staleness of a change made on another server.
const CACHE_TTL_SECONDS = 60;

function cacheKey(userId: string) {
  return `${CACHE_PREFIX}${ADULT_PREFERENCE_KEY}:${userId}`;
}

export class AdultService {
  constructor(
    private db: Database,
    private redis: Redis
  ) {}

  /**
   * Only a real JSON `true` opens the gate. A stray string "true" or a 1 left
   * behind by the custom-preference modal does not — the preference is
   * free-form JSON, so this is a shape we can actually receive.
   */
  async isAllowed(userId?: string | null): Promise<boolean> {
    if (!userId) return false;

    const cached = await this.redis
      .get<boolean>(cacheKey(userId))
      .catch(() => null);
    if (typeof cached === "boolean") return cached;

    const row = await this.db
      .query<{ value: unknown }>(
        `SELECT value FROM user_preferences WHERE user_id = $1 AND key = $2`,
        [userId, ADULT_PREFERENCE_KEY]
      )
      .catch(() => null);

    const allowed = row?.rows[0]?.value === true;

    await this.redis
      .set(cacheKey(userId), allowed, CACHE_TTL_SECONDS)
      .catch(() => {});

    return allowed;
  }

  /**
   * Called when the preference is written or deleted, so the toggle takes
   * effect on the next request instead of up to a minute later.
   */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(cacheKey(userId)).catch(() => {});
  }
}
