import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type JwtPayload } from "./jwt.js";
import type { Database } from "../database/db.js";

// Augment Express Request with user
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return null;
}

/**
 * Requires a valid JWT. Returns 401 if missing or invalid.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: "Unauthorized", message: "Missing access token." });
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized", message: "Invalid or expired access token." });
  }
}

/** The ADMIN_EMAILS allowlist, lowercased. */
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

/**
 * Requires the authenticated user to be an admin: their account's email is in
 * ADMIN_EMAILS (comma-separated env var) **and** that email has been verified.
 * Must run after requireAuth. Returns 403 if either half fails.
 *
 * Both halves are read from the `users` row, not from the JWT, and the
 * verification half is the whole point. `POST /api/auth/register` accepts any
 * address and immediately mints a session carrying it, so on an install whose
 * admin address hasn't registered yet — a fresh deploy, or an admin who
 * changed their email — anyone could register *as* the admin address and be
 * handed a full admin session without ever seeing the inbox. Requiring
 * `email_verified` means holding the address is what grants admin, which is
 * what naming an address in ADMIN_EMAILS was always meant to express.
 *
 * A factory rather than a plain middleware because that check needs the
 * database, which the module can't reach on its own.
 */
export function createRequireAdmin(db: Database) {
  return async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const forbidden = () =>
      res.status(403).json({
        error: "Forbidden",
        reason: "not_admin",
        message: "Admin access required.",
      });

    // Cheap reject first — an ordinary user's token never gets a DB round trip.
    if (!req.user?.sub || !isAdminEmail(req.user.email)) {
      forbidden();
      return;
    }

    let row: { email: string; email_verified: boolean } | null;
    try {
      row = await db.one<{ email: string; email_verified: boolean }>(
        `SELECT email, email_verified FROM users WHERE id = $1`,
        [req.user.sub],
      );
    } catch (err) {
      console.error("[auth] admin check failed:", err);
      res.status(503).json({
        error: "Unavailable",
        reason: "check_failed",
        message: "Could not verify admin access.",
      });
      return;
    }

    // The JWT's email is a 15-minute-old copy; the row is the current truth.
    if (!row || !isAdminEmail(row.email)) {
      forbidden();
      return;
    }

    if (!row.email_verified) {
      // Worth a log line: from the operator's side this looks like ADMIN_EMAILS
      // simply not working, and nothing else would say why.
      console.warn(
        `[auth] admin access refused for ${row.email}: email not verified. ` +
          `Click the link in the verification mail, request a new one via ` +
          `POST /api/auth/verify-email/resend, or sign in with Google/Discord on that address.`,
      );

      // A distinct `reason`, not the same opaque 403 a non-admin gets. This
      // fires on every install that upgraded into the verification requirement
      // with an admin who registered before it existed and never verified —
      // likely, since the default mail transport prints instead of sending. To
      // that operator the admin panel simply disappears, and a server-side
      // `console.warn` is not where they will look. The account page reads
      // this and says what to do.
      res.status(403).json({
        error: "Forbidden",
        reason: "email_unverified",
        message:
          "Your address is in ADMIN_EMAILS, but it hasn't been verified yet. " +
          "Verify it — check your inbox, request a new link, or sign in with " +
          "Google/Discord on that address — and admin access turns on.",
      });
      return;
    }

    next();
  };
}

/**
 * Attaches user to req if a valid JWT is present, but doesn't block the request.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);

  if (token) {
    try {
      req.user = verifyAccessToken(token);
    } catch {
      // ignore invalid token — treat as unauthenticated
    }
  }

  next();
}