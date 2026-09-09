import jwt from "jsonwebtoken";
import crypto from "crypto";

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

const ACCESS_TTL  = "15m";
const REFRESH_TTL = "30d";
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface JwtPayload {
  sub: string;   // user id
  email: string;
}

// ── Access token ─────────────────────────────────────────────

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

export function verifyAccessToken(token: string): JwtPayload {
  const payload = jwt.verify(token, ACCESS_SECRET) as JwtPayload & { iat?: number };

  if (payload.sub && isRevoked(payload.sub, payload.iat)) {
    throw new jwt.JsonWebTokenError("Token revoked");
  }

  return payload;
}

// ── Access-token revocation ──────────────────────────────────

/**
 * Access tokens are stateless and live 15 minutes, so revoking a *session*
 * (`revokeAllRefreshTokens`) leaves the token already in the attacker's hand
 * working until it expires on its own. Usually that is an acceptable trade —
 * it is the reason the TTL is short — but not for
 * `AccountService.upsertOAuthUser`'s account claim, where the whole point is
 * that the person who pre-registered someone else's address loses access *now*
 * rather than in a quarter of an hour.
 *
 * The registry is in-process, which is a real limit and a deliberate one. This
 * app runs as a single container (`RoomHub` already assumes the same, and says
 * so); a second instance would not see the cutoff and would fall back to
 * exactly today's behaviour, so the failure mode is "no worse than before",
 * not "silently broken". Doing it properly means a `token_valid_after` column
 * and a database round trip on *every* authenticated request, which is a
 * steep price for an event that happens once per account at most.
 *
 * Entries are dropped once no token issued before the cutoff could still be
 * valid, so this never grows.
 */
const ACCESS_TTL_MS = 15 * 60 * 1000;

/**
 * `iat` has one-second resolution, and the claim is immediately followed by
 * minting a *new* session for the rightful owner — which can land in the same
 * second. Requiring a token to be strictly newer than the cutoff would lock
 * that fresh session out. One second of slack keeps it, and costs nothing
 * against the token being revoked, which was issued minutes earlier.
 */
const IAT_SLACK_MS = 1000;

const accessCutoffs = new Map<string, number>();

/** Invalidates every access token issued to `userId` before now. */
export function revokeAccessTokensFor(userId: string): void {
  const now = Date.now();

  for (const [id, cutoff] of accessCutoffs) {
    if (cutoff + ACCESS_TTL_MS <= now) accessCutoffs.delete(id);
  }

  accessCutoffs.set(userId, now);
}

function isRevoked(userId: string, iat?: number): boolean {
  const cutoff = accessCutoffs.get(userId);
  if (cutoff === undefined) return false;

  if (cutoff + ACCESS_TTL_MS <= Date.now()) {
    accessCutoffs.delete(userId);
    return false;
  }

  // No `iat` at all — a token this process didn't mint the way it mints them.
  // Nothing legitimate reaches here without one.
  if (typeof iat !== "number") return true;

  return iat * 1000 < cutoff - IAT_SLACK_MS;
}

/** Test seam — nothing in the app clears the registry. */
export function clearAccessRevocations(): void {
  accessCutoffs.clear();
}

// ── Refresh token ────────────────────────────────────────────

export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiresAt(): Date {
  return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
}

export { REFRESH_TTL_SECONDS };