//account.service.ts
import crypto from "crypto";
import { Database } from "../database/db.js";
import { Redis } from "../database/redis.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiresAt,
  revokeAccessTokensFor,
  REFRESH_TTL_SECONDS,
} from "../auth/jwt.js";
import type { OAuthProfile } from "../auth/oauth.js";
import { MailService } from "./mail.service.js";

// ── Types ────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  email_verified: boolean;
  created_at: Date;
}

/**
 * Filters shared by the watchlist and favorites listings — the two tables have
 * the same shape, so the same five predicates apply to both.
 */
export interface LibraryFilters {
  provider?: string;
  search?: string;
  rating?: number;
  minRating?: number;
  maxRating?: number;
}

/** How much of a listing to return. An absent `limit` means "everything". */
export interface PageOptions {
  limit?: number;
  offset?: number;
}

/**
 * Builds the WHERE clause shared by a library listing and its COUNT.
 *
 * Both callers must produce byte-identical predicates or the total reported to
 * the client stops describing the list it is paging through — hence one builder
 * rather than two hand-kept copies. `alias` is the library table's alias (`w`
 * for watchlist, `f` for favorites); ratings always join as `r`.
 */
function buildLibraryConditions(
  alias: string,
  userId: string,
  filters: LibraryFilters
): { conditions: string[]; params: unknown[]; nextIdx: number } {
  const conditions: string[] = [`${alias}.user_id = $1`];
  const params: unknown[] = [userId];
  let i = 2;

  if (filters.provider) {
    conditions.push(`${alias}.provider = $${i++}`);
    params.push(filters.provider);
  }
  if (filters.search) {
    conditions.push(`${alias}.show_id ILIKE $${i++}`);
    params.push(`%${filters.search}%`);
  }
  if (filters.rating !== undefined) {
    conditions.push(`r.rating = $${i++}`);
    params.push(filters.rating);
  }
  if (filters.minRating !== undefined) {
    conditions.push(`r.rating >= $${i++}`);
    params.push(filters.minRating);
  }
  if (filters.maxRating !== undefined) {
    conditions.push(`r.rating <= $${i++}`);
    params.push(filters.maxRating);
  }

  return { conditions, params, nextIdx: i };
}

export interface HistoryFilters {
  provider?: string;
  completed?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
}

/**
 * Watch history's WHERE clause, shared by its listing and its COUNT for the
 * same reason as `buildLibraryConditions`. The table is queried unaliased.
 */
function buildHistoryConditions(
  userId: string,
  filters: HistoryFilters
): { conditions: string[]; params: unknown[]; nextIdx: number } {
  const conditions: string[] = [`user_id = $1`];
  const params: unknown[] = [userId];
  let i = 2;

  if (filters.provider) {
    conditions.push(`provider = $${i++}`);
    params.push(filters.provider);
  }
  if (filters.completed !== undefined) {
    conditions.push(`completed = $${i++}`);
    params.push(filters.completed);
  }
  if (filters.dateFrom) {
    conditions.push(`watched_at >= $${i++}`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`watched_at <= $${i++}`);
    params.push(filters.dateTo);
  }
  if (filters.search) {
    conditions.push(`(show_id ILIKE $${i} OR episode_label ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i++;
  }

  return { conditions, params, nextIdx: i };
}

/**
 * Appends `LIMIT`/`OFFSET` to a query, or nothing at all when no limit is given.
 *
 * An absent limit has to stay unbounded: the Flutter client fetches these
 * listings whole and has no paging of its own, so defaulting to a page size
 * would silently truncate a large library instead of erroring.
 */
function paginate(
  page: PageOptions,
  params: unknown[],
  nextIdx: number
): { clause: string; nextIdx: number } {
  if (page.limit === undefined) return { clause: "", nextIdx };

  let i = nextIdx;
  params.push(page.limit);
  const limitIdx = i++;
  params.push(page.offset ?? 0);
  const offsetIdx = i++;
  return { clause: ` LIMIT $${limitIdx} OFFSET $${offsetIdx}`, nextIdx: i };
}

// ── AccountService ───────────────────────────────────────────

export class AccountService {
  private readonly mailService: MailService;
  constructor(
    private readonly db: Database,
    private readonly redis: Redis
  ) {
    this.mailService = new MailService();
  }

  // ── Registration / login ──────────────────────────────────

  async register(email: string, password: string, displayName?: string): Promise<User> {
    const existing = await this.db.query(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );
    if (existing.rows.length > 0) {
      throw new Error("EMAIL_TAKEN");
    }

    const passwordHash       = await hashPassword(password);
    const verificationToken  = crypto.randomBytes(32).toString("hex");

    const result = await this.db.query<User>(
      `INSERT INTO users (email, password_hash, display_name, verification_token, verification_token_exp)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, display_name, avatar_url, email_verified, created_at`,
      [email, passwordHash, displayName ?? null, verificationToken, AccountService.verificationExpiry()]
    );

    // Mail comes after the INSERT and is best-effort on purpose: a mail
    // outage (or an install with no transport configured at all) must not
    // cost the user their account. They can ask for a fresh verification
    // link later via POST /api/auth/verify-email/resend.
    await this.mailService
      .sendVerificationEmail(email, verificationToken)
      .catch((err) => console.error("[Mail] verification send failed:", err?.message ?? err));
    await this.mailService
      .sendWelcomeEmail(email, displayName ?? null)
      .catch((err) => console.error("[Mail] welcome send failed:", err?.message ?? err));

    return result.rows[0];
  }

  async loginWithPassword(email: string, password: string): Promise<User> {
    const result = await this.db.query<User & { password_hash: string }>(
      `SELECT id, email, display_name, avatar_url, email_verified, created_at, password_hash
       FROM users WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];
    if (!user) throw new Error("INVALID_CREDENTIALS");

    // No hash at all means this account has no password to check against: it
    // signed up through OAuth, or its unproven password was dropped when an
    // OAuth identity claimed the address (see upsertOAuthUser). That is a
    // wrong-credentials answer, not an error — bcrypt.compare throws on a null
    // hash, which the login route would have turned into a 500.
    if (!user.password_hash) throw new Error("INVALID_CREDENTIALS");

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) throw new Error("INVALID_CREDENTIALS");

    const { password_hash, ...safeUser } = user;
    return safeUser as User;
  }

  // ── OAuth upsert ──────────────────────────────────────────

  async upsertOAuthUser(profile: OAuthProfile): Promise<User> {
    // Check if oauth_account already exists
    const existing = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM oauth_accounts
       WHERE provider = $1 AND provider_user_id = $2`,
      [profile.provider, profile.providerUserId]
    );

    if (existing.rows.length > 0) {
      const userId = existing.rows[0].user_id;

      await this.db.query(
        `UPDATE oauth_accounts
        SET access_token = $3, refresh_token = $4, token_exp = $5, updated_at = NOW()
        WHERE provider = $1 AND provider_user_id = $2`,
        [
          profile.provider,
          profile.providerUserId,
          profile.accessToken,
          profile.refreshToken ?? null,
          profile.tokenExp    ?? null,
        ]
      );

      return this.getUserById(userId);
    }

    // No existing OAuth account — this identity is about to be attached to a
    // local account, and the only thing tying the two together is the email
    // address the provider reported. So the address has to be one the provider
    // actually confirmed.
    //
    // Discord is the reason this is not theoretical: an account there can
    // carry any address the user typed in, unconfirmed. Without this check,
    // signing in with a throwaway Discord account whose email is set to
    // someone else's Streamio address links the two and returns a session for
    // *their* account — one request, full takeover, and the link persists.
    // Google is stricter but reports the same field, so both are treated the
    // same way rather than one being trusted by reputation.
    if (!profile.email) {
      throw new Error("OAUTH_EMAIL_MISSING");
    }
    if (!profile.emailVerified) {
      throw new Error("OAUTH_EMAIL_UNVERIFIED");
    }

    let userId: string;

    const byEmail = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [profile.email]
    );

    if (byEmail.rows.length > 0) {
      userId = byEmail.rows[0].id;

      // The local account may be one that registered with a password and never
      // verified — which means nobody ever proved they hold this inbox, while
      // the OAuth provider just did. So the provider's word settles ownership,
      // and the unproven password is dropped along with any session it opened.
      //
      // That is not tidiness, it is the other half of the takeover: registering
      // `victim@example.com` first and sitting on it means that when the real
      // owner signs in with Google, they land in an account whose password an
      // attacker still knows. The rightful owner keeps the account (they now
      // sign in through the provider) and can set a password again through
      // password reset, which goes to the inbox they demonstrably own.
      const claimed = await this.db.query<{ id: string; display_name: string | null }>(
        `UPDATE users
            SET email_verified         = TRUE,
                verification_token     = NULL,
                verification_token_exp = NULL,
                password_hash          = NULL
          WHERE id = $1 AND email_verified = FALSE
          RETURNING id, display_name`,
        [userId]
      );

      if (claimed.rows.length) {
        await this.revokeAllRefreshTokens(userId);

        // Refresh tokens are stateful and die here; the 15-minute access token
        // already in someone's hand is not, and this is the one case where
        // waiting it out is not good enough — a squatter who pre-registered
        // this address keeps full API access to the account the rightful owner
        // just claimed. See `revokeAccessTokensFor`.
        revokeAccessTokensFor(userId);

        // Destroying a credential silently is the wrong half of being careful.
        // The attack this defends against is real, but so is the ordinary case
        // it fires on: someone registered with a password, never received (or
        // never clicked) the verification mail — routine here, where the
        // default transport prints instead of sending and the tunnel hostname
        // rotates — and then signed in with Google once. Their password is now
        // gone. Without a notice their next email+password login is an
        // unexplained "invalid credentials", forever.
        //
        // Best-effort, and after the write: this must not be able to fail a
        // sign-in, exactly like the verification mail in `register()`.
        this.mailService
          .sendOAuthClaimEmail(
            profile.email,
            profile.provider,
            claimed.rows[0].display_name
          )
          .catch((err) => {
            console.warn(
              `[account] could not send OAuth-claim notice to ${profile.email}:`,
              err
            );
          });
      }
    } else {
      const newUser = await this.db.query<{ id: string }>(
        `INSERT INTO users (email, display_name, avatar_url, email_verified)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id`,
        [profile.email, profile.displayName, profile.avatarUrl ?? null]
      );
      userId = newUser.rows[0].id;
    }

    await this.db.query(
      `INSERT INTO oauth_accounts
         (user_id, provider, provider_user_id, access_token, refresh_token, token_exp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, profile.provider, profile.providerUserId,
       profile.accessToken, profile.refreshToken ?? null, profile.tokenExp ?? null]
    );

    return this.getUserById(userId);
  }

  // ── Refresh tokens ────────────────────────────────────────

  async createRefreshToken(userId: string): Promise<string> {
    const raw   = generateRefreshToken();
    const hash  = hashRefreshToken(raw);
    const exp   = refreshTokenExpiresAt();

    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, hash, exp]
    );

    // Mirror in Redis for fast lookup
    await this.redis.set(
      `rt:${hash}`,
      userId,
      REFRESH_TTL_SECONDS
    );

    return raw;
  }

  /**
   * How long a just-rotated refresh token keeps working.
   *
   * Rotation revokes the old token the moment the new one is minted, which
   * means the client is signed out for good if it never receives the reply:
   * a dropped connection, a tunnel hiccup, or the app being killed mid-call
   * all leave it holding a token the server has already retired. The window
   * below lets that client come back and get a working session instead of a
   * login screen. It also absorbs two requests racing on the same token,
   * where the loser would otherwise invalidate the winner.
   */
  private static readonly ROTATION_GRACE_SECONDS = 60;

  async rotateRefreshToken(
    rawToken: string
  ): Promise<{ user: User; newRawToken: string }> {
    const hash = hashRefreshToken(rawToken);

    // Postgres is the source of truth for whether a token is still live.
    const result = await this.db.query<{
      id: string;
      user_id: string;
      expires_at: Date;
      revoked: boolean;
    }>(
      `SELECT id, user_id, expires_at, revoked
       FROM refresh_tokens WHERE token_hash = $1`,
      [hash]
    );

    const record = result.rows[0];
    const live   = record && !record.revoked && new Date() <= record.expires_at;

    if (live) {
      await this.db.query(
        `UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1`,
        [record.id]
      );
      await this.redis.delete(`rt:${hash}`);
      // Remember, briefly, that this token was retired by a rotation and not
      // by a logout — see ROTATION_GRACE_SECONDS.
      await this.redis.set(
        `rtg:${hash}`,
        record.user_id,
        AccountService.ROTATION_GRACE_SECONDS
      );

      return this.issueRotation(record.user_id);
    }

    // Not live — but if we rotated it ourselves moments ago, the client is
    // simply retrying a call whose answer it never got. Give it a session.
    const graceUserId = await this.redis.get<string>(`rtg:${hash}`);
    if (graceUserId) {
      return this.issueRotation(graceUserId);
    }

    // Genuinely dead: revoked long ago, expired, or never ours. Only this
    // token is rejected. Revoking the user's other sessions here would turn
    // one stale client — an old phone, a tab left open past the 30-day TTL —
    // into a forced sign-out on every device they own.
    throw new Error("INVALID_REFRESH_TOKEN");
  }

  private async issueRotation(
    userId: string
  ): Promise<{ user: User; newRawToken: string }> {
    const newRawToken = await this.createRefreshToken(userId);
    const user        = await this.getUserById(userId);

    return { user, newRawToken };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    const hash = hashRefreshToken(rawToken);
    await this.db.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
      [hash]
    );
    await this.redis.delete(`rt:${hash}`);
  }

  async revokeAllRefreshTokens(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE`,
      [userId]
    );
    // Redis keys will expire naturally; no bulk delete needed
  }

  // ── Password reset ────────────────────────────────────────

  async requestPasswordReset(email: string): Promise<void> {
    const token   = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hr

    await this.db.query(
      `UPDATE users SET reset_token = $1, reset_token_exp = $2 WHERE email = $3`,
      [token, expires, email]
    );

    await this.mailService.sendPasswordResetEmail(email, token);
    
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM users
       WHERE reset_token = $1 AND reset_token_exp > NOW()`,
      [token]
    );

    if (!result.rows.length) throw new Error("INVALID_OR_EXPIRED_RESET_TOKEN");

    const hash = await hashPassword(newPassword);
    const userId = result.rows[0].id;

    await this.db.query(
      `UPDATE users
       SET password_hash = $1, reset_token = NULL, reset_token_exp = NULL
       WHERE id = $2`,
      [hash, userId]
    );

    // Invalidate all sessions after password change
    await this.revokeAllRefreshTokens(userId);
  }

  // ── Email verification ────────────────────────────────────

  /**
   * Consumes the token `register()` generated and mailed out. Idempotent by
   * consumption: the token is cleared on success, so a second click on the
   * same link finds no row and raises INVALID_TOKEN.
   */
  /**
   * Issues a *fresh* verification token and mails it out again.
   *
   * Necessary because a link can go stale through no fault of the user: the
   * link's host is whatever public URL the server had when the mail was sent,
   * and an install behind the Cloudflare tunnel gets a new hostname on every
   * restart. Silent (no throw) for an unknown or already-verified address, so
   * this can't be used to probe which emails have accounts.
   */
  async resendVerificationEmail(email: string): Promise<void> {
    const token = crypto.randomBytes(32).toString("hex");

    const result = await this.db.query<{ display_name: string | null }>(
      `UPDATE users SET verification_token = $1, verification_token_exp = $2
       WHERE email = $3 AND email_verified = FALSE
       RETURNING display_name`,
      [token, AccountService.verificationExpiry(), email]
    );
    if (!result.rows.length) return;

    await this.mailService.sendVerificationEmail(email, token);
  }

  /**
   * How long a verification link stays good, mirroring `reset_token_exp`.
   *
   * A day is generous for a link the user was just told to click, and short
   * enough that one left in an old inbox stops being worth anything. Expiring
   * is not a dead end: `/api/auth/verify-email/resend` issues a fresh link,
   * which an install behind a rotating tunnel hostname already needs.
   */
  private static readonly VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;

  private static verificationExpiry(): Date {
    return new Date(Date.now() + AccountService.VERIFICATION_TTL_MS);
  }

  async verifyEmail(token: string): Promise<User> {
    const result = await this.db.query<User>(
      `UPDATE users
       SET email_verified = TRUE, verification_token = NULL, verification_token_exp = NULL
       WHERE verification_token = $1
         AND verification_token_exp IS NOT NULL
         AND verification_token_exp > NOW()
       RETURNING id, email, display_name, avatar_url, email_verified, created_at`,
      [token]
    );
    if (!result.rows.length) throw new Error("INVALID_TOKEN");
    return result.rows[0];
  }

  // ── User queries ──────────────────────────────────────────

  async getUserById(id: string): Promise<User> {
    const result = await this.db.query<User>(
      `SELECT id, email, display_name, avatar_url, email_verified, created_at
       FROM users WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) throw new Error("USER_NOT_FOUND");
    return result.rows[0];
  }

  async updateProfile(
    userId: string,
    data: { displayName?: string; avatarUrl?: string }
  ): Promise<User> {
    const result = await this.db.query<User>(
      `UPDATE users
       SET display_name = COALESCE($2, display_name),
           avatar_url   = COALESCE($3, avatar_url)
       WHERE id = $1
       RETURNING id, email, display_name, avatar_url, email_verified, created_at`,
      [userId, data.displayName ?? null, data.avatarUrl ?? null]
    );
    return result.rows[0];
  }

  // ── Watchlist ─────────────────────────────────────────────

  async getWatchlist(userId: string, page: PageOptions = {}) {
    const params: unknown[] = [userId];
    const { clause } = paginate(page, params, 2);
    const result = await this.db.query(
      `SELECT provider, show_id, added_at FROM watchlist
       WHERE user_id = $1 ORDER BY added_at DESC${clause}`,
      params
    );
    return result.rows;
  }

  async countWatchlist(userId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM watchlist WHERE user_id = $1`,
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async addToWatchlist(userId: string, provider: string, showId: string) {
    await this.db.query(
      `INSERT INTO watchlist (user_id, provider, show_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, provider, show_id) DO NOTHING`,
      [userId, provider, showId]
    );
  }

  async removeFromWatchlist(userId: string, provider: string, showId: string) {
    await this.db.query(
      `DELETE FROM watchlist WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
      [userId, provider, showId]
    );
  }

  // ── Watchlist (filtered) ───────────────────────────────────
  // NOTE: ratings live in a separate table keyed by (user_id, provider, show_id).
  // We LEFT JOIN so items without a rating are still included unless a rating filter is given.
  async getWatchlistFiltered(
    userId: string,
    filters: LibraryFilters,
    page: PageOptions = {}
  ) {
    const { conditions, params, nextIdx } = buildLibraryConditions("w", userId, filters);
    const { clause } = paginate(page, params, nextIdx);

    const result = await this.db.query(
      `SELECT w.provider, w.show_id, w.added_at, r.rating
       FROM watchlist w
       LEFT JOIN ratings r
         ON r.user_id = w.user_id AND r.provider = w.provider AND r.show_id = w.show_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY w.added_at DESC${clause}`,
      params
    );
    return result.rows;
  }

  async countWatchlistFiltered(userId: string, filters: LibraryFilters): Promise<number> {
    const { conditions, params } = buildLibraryConditions("w", userId, filters);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM watchlist w
       LEFT JOIN ratings r
         ON r.user_id = w.user_id AND r.provider = w.provider AND r.show_id = w.show_id
       WHERE ${conditions.join(" AND ")}`,
      params
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ── Watch history ─────────────────────────────────────────

  async getWatchHistory(userId: string, limit = 50, offset = 0) {
    const result = await this.db.query(
      `SELECT provider, show_id, episode_id, progress_seconds, completed, watched_at, episode_label, duration_seconds
       FROM watch_history
       WHERE user_id = $1
       ORDER BY watched_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return result.rows;
  }

  async countWatchHistory(userId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM watch_history WHERE user_id = $1`,
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ── Watch history (filtered) ────────────────────────────────
  async getWatchHistoryFiltered(
    userId: string,
    filters: HistoryFilters,
    limit = 50,
    offset = 0
  ) {
    const { conditions, params, nextIdx } = buildHistoryConditions(userId, filters);
    const { clause } = paginate({ limit, offset }, params, nextIdx);

    const result = await this.db.query(
      `SELECT provider, show_id, episode_id, progress_seconds, completed, watched_at, episode_label, duration_seconds
       FROM watch_history
       WHERE ${conditions.join(" AND ")}
       ORDER BY watched_at DESC${clause}`,
      params
    );
    return result.rows;
  }

  async countWatchHistoryFiltered(userId: string, filters: HistoryFilters): Promise<number> {
    const { conditions, params } = buildHistoryConditions(userId, filters);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM watch_history WHERE ${conditions.join(" AND ")}`,
      params
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // Every episode row for one show — lets the watch page mark each episode
  // button as completed/in-progress without one request per episode.
  async getWatchProgressForShow(userId: string, provider: string, showId: string) {
    const result = await this.db.query(
      `SELECT episode_id, progress_seconds, completed, duration_seconds
       FROM watch_history
       WHERE user_id = $1 AND provider = $2 AND show_id = $3 AND episode_id IS NOT NULL`,
      [userId, provider, showId]
    );
    return result.rows;
  }

  async getWatchProgress(
    userId: string,
    provider: string,
    showId: string,
    episodeId: string | null
  ) {
    const result = await this.db.query(
      `SELECT progress_seconds, completed, watched_at, episode_label, duration_seconds
        FROM watch_history
        WHERE user_id = $1
          AND provider = $2
          AND show_id = $3
          AND (
            ($4::text IS NULL AND episode_id IS NULL)
            OR episode_id = $4::text
          )
        ORDER BY watched_at DESC
        LIMIT 1`,
      [userId, provider, showId, episodeId]
    );

    return result.rows[0] ?? null;
  }

  async upsertWatchProgress(
    userId: string,
    provider: string,
    showId: string,
    episodeId: string | null,
    progressSeconds: number,
    completed = false,
    episodeLabel: string | null = null,
    durationSeconds: number | null = null
  ) {
    // watch_history has two *partial* unique indexes (one per episode_id nullity —
    // see database/migrations/init.sql), so the ON CONFLICT target must repeat the
    // matching WHERE predicate or Postgres won't use it as the arbiter and a second
    // write for the same movie/episode throws a raw duplicate-key error instead of
    // updating.
    const conflictTarget =
      episodeId === null
        ? "(user_id, show_id) WHERE episode_id IS NULL"
        : "(user_id, show_id, episode_id) WHERE episode_id IS NOT NULL";

    // The three writes are one statement so the lifetime counter and the
    // activity day can never land without the history row they describe, or
    // vice versa. See database/migrations/003_stats_badges.sql.
    await this.db.query(
      `WITH history AS (
        INSERT INTO watch_history
          (user_id, provider, show_id, episode_id, episode_label, progress_seconds, duration_seconds, completed, watched_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT ${conflictTarget}
        DO UPDATE SET
          provider         = EXCLUDED.provider,
          episode_label    = COALESCE(EXCLUDED.episode_label, watch_history.episode_label),
          progress_seconds = EXCLUDED.progress_seconds,
          duration_seconds = COALESCE(EXCLUDED.duration_seconds, watch_history.duration_seconds),
          completed        = EXCLUDED.completed,
          watched_at       = NOW()
      ),
      day AS (
        INSERT INTO user_watch_days (user_id, day)
        VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date)
        ON CONFLICT DO NOTHING
      )
      INSERT INTO user_stats (user_id, total_watch_seconds, updated_at)
      VALUES ($1, $9::int, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        total_watch_seconds = user_stats.total_watch_seconds + EXCLUDED.total_watch_seconds,
        updated_at          = NOW()`,
      [
        userId, provider, showId, episodeId, episodeLabel,
        progressSeconds, durationSeconds, completed,
        // Delta computed here rather than in SQL so `prev` is only needed once:
        // a client that seeks backwards or restarts a rewatch reports *less*
        // than last time, which is 0 watched, not negative time.
        await this.watchTimeDelta(userId, showId, episodeId, progressSeconds),
      ]
    );
  }

  /**
   * How much new watch time a progress report represents: how far past the
   * previously recorded point it reaches, clamped into a sane range.
   *
   * The clamp is what keeps the lifetime counter honest — a client is free to
   * POST any number, and a resolved stream that reports a garbage duration (or
   * a seek straight to the end of a 12-hour "episode") would otherwise mint
   * hours out of nothing. Anything past a single sitting is treated as a jump,
   * not as time spent.
   */
  private static readonly MAX_WATCH_DELTA_SECONDS = 4 * 60 * 60;

  private async watchTimeDelta(
    userId: string,
    showId: string,
    episodeId: string | null,
    progressSeconds: number
  ): Promise<number> {
    if (!Number.isFinite(progressSeconds) || progressSeconds <= 0) return 0;

    const row = await this.db.one<{ progress_seconds: number }>(
      `SELECT progress_seconds
      FROM watch_history
      WHERE user_id = $1
        AND show_id = $2
        AND (($3::text IS NULL AND episode_id IS NULL) OR episode_id = $3::text)`,
      [userId, showId, episodeId]
    );

    const prior = row ? Math.max(0, Number(row.progress_seconds) || 0) : 0;
    const delta = Math.floor(progressSeconds) - prior;

    if (delta <= 0) return 0;
    return Math.min(delta, AccountService.MAX_WATCH_DELTA_SECONDS);
  }

  async deleteHistoryEntry(
    userId: string,
    provider: string,
    showId: string,
    episodeId: string | null
  ) {
    await this.db.query(
      `DELETE FROM watch_history
      WHERE user_id = $1 AND provider = $2 AND show_id = $3
      AND (episode_id = $4 OR ($4 IS NULL AND episode_id IS NULL))`,
      [userId, provider, showId, episodeId]
    );
  }

  async clearHistory(userId: string) {
    await this.db.query(
      `DELETE FROM watch_history WHERE user_id = $1`,
      [userId]
      );
    }

  async deleteUser(userId: string): Promise<void> {
    await this.revokeAllRefreshTokens(userId);
    await this.db.query(`DELETE FROM watchlist         WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM watch_history     WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM favorites         WHERE user_id = $1`, [userId]); // +
    await this.db.query(`DELETE FROM ratings           WHERE user_id = $1`, [userId]); // +
    await this.db.query(`DELETE FROM user_preferences  WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM oauth_accounts    WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM refresh_tokens    WHERE user_id = $1`, [userId]);
    await this.db.query(`DELETE FROM users             WHERE id      = $1`, [userId]);
  }
  // ── Favorites ─────────────────────────────────────────────

  async getFavorites(userId: string, page: PageOptions = {}) {
    const params: unknown[] = [userId];
    const { clause } = paginate(page, params, 2);
    const result = await this.db.query(
      `SELECT provider, show_id, added_at FROM favorites
      WHERE user_id = $1 ORDER BY added_at DESC${clause}`,
      params
    );
    return result.rows;
  }

  async countFavorites(userId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM favorites WHERE user_id = $1`,
      [userId]
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async addFavorite(userId: string, provider: string, showId: string) {
    await this.db.query(
      `INSERT INTO favorites (user_id, provider, show_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, provider, show_id) DO NOTHING`,
      [userId, provider, showId]
    );
  }

  async removeFavorite(userId: string, provider: string, showId: string) {
    await this.db.query(
      `DELETE FROM favorites WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
      [userId, provider, showId]
    );
  }

  async isFavorite(userId: string, provider: string, showId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM favorites WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
      [userId, provider, showId]
    );
    return result.rows.length > 0;
  }

  // ── Favorites (filtered) ───────────────────────────────────
  async getFavoritesFiltered(
    userId: string,
    filters: LibraryFilters,
    page: PageOptions = {}
  ) {
    const { conditions, params, nextIdx } = buildLibraryConditions("f", userId, filters);
    const { clause } = paginate(page, params, nextIdx);

    const result = await this.db.query(
      `SELECT f.provider, f.show_id, f.added_at, r.rating
       FROM favorites f
       LEFT JOIN ratings r
         ON r.user_id = f.user_id AND r.provider = f.provider AND r.show_id = f.show_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY f.added_at DESC${clause}`,
      params
    );
    return result.rows;
  }

  async countFavoritesFiltered(userId: string, filters: LibraryFilters): Promise<number> {
    const { conditions, params } = buildLibraryConditions("f", userId, filters);
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM favorites f
       LEFT JOIN ratings r
         ON r.user_id = f.user_id AND r.provider = f.provider AND r.show_id = f.show_id
       WHERE ${conditions.join(" AND ")}`,
      params
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // ── Ratings ───────────────────────────────────────────────

  async getRating(userId: string, provider: string, showId: string): Promise<number | null> {
    const result = await this.db.query<{ rating: number }>(
      `SELECT rating FROM ratings WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
      [userId, provider, showId]
    );
    return result.rows[0]?.rating ?? null;
  }

  async getAllRatings(userId: string) {
    const result = await this.db.query(
      `SELECT provider, show_id, rating, created_at, updated_at FROM ratings
      WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId]
    );
    return result.rows;
  }

  async upsertRating(userId: string, provider: string, showId: string, rating: number) {
    await this.db.query(
      `INSERT INTO ratings (user_id, provider, show_id, rating)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, provider, show_id)
      DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()`,
      [userId, provider, showId, rating]
    );
  }

  async deleteRating(userId: string, provider: string, showId: string) {
    await this.db.query(
      `DELETE FROM ratings WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
      [userId, provider, showId]
    );
  }

  // ── Preferences ───────────────────────────────────────────

  async getPreferences(userId: string): Promise<Record<string, unknown>> {
    const result = await this.db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM user_preferences WHERE user_id = $1`,
      [userId]
    );
    return Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
  }

  async setPreference(userId: string, key: string, value: unknown) {
    await this.db.query(
      `INSERT INTO user_preferences (user_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [userId, key, JSON.stringify(value)]
    );
  }

  async deletePreference(userId: string, key: string) {
    await this.db.query(
      `DELETE FROM user_preferences WHERE user_id = $1 AND key = $2`,
      [userId, key]
    );
  }
}