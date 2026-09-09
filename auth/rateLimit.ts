import type { Request, Response, NextFunction } from "express";
import type { Redis as RedisClient } from "../database/redis.js";
import { hashRefreshToken } from "./jwt.js";

interface RateLimitOptions {
  /** Redis client instance */
  redis: RedisClient;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Maximum requests per window */
  max: number;
  /** Key prefix — e.g. "rl:login" */
  prefix: string;
  /** Derive the rate-limit key from the request (default: IP) */
  keyFn?: (req: Request) => string;
}

/**
 * Returns an Express middleware that rate-limits requests using Redis.
 * Uses a simple fixed-window counter stored as a Redis string with TTL.
 */
export function redisRateLimit(opts: RateLimitOptions) {
  const keyFn =
    opts.keyFn ??
    ((req: Request) => {
      const ip =
        (req.headers["x-forwarded-for"] as string)
          ?.split(",")[0]
          ?.trim() ??
        req.socket.remoteAddress ??
        "unknown";

      return ip;
    });

  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = keyFn(req);
    const key = `${opts.prefix}:${identifier}`;

    try {
      const raw = await opts.redis.get<string>(key);

      const current = raw ? Number(raw) : 0;

      // block
      if (current >= opts.max) {
        res.setHeader("Retry-After", String(opts.windowSeconds));
        res.status(429).json({
          error: "Too Many Requests",
          message: `Rate limit exceeded. Try again in ${opts.windowSeconds} seconds.`,
        });
        return;
      }

      const newCount = current + 1;

      // ALWAYS overwrite as plain string number
      await opts.redis.set(key, String(newCount), opts.windowSeconds);

      res.setHeader("X-RateLimit-Limit", String(opts.max));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, opts.max - newCount))
      );

      next();
    } catch (err) {
      console.error("[RateLimit] Redis error, failing open:", err);
      next();
    }
  };
}

// ── Pre-configured limiters ───────────────────────────────────────────────────
// Import and use these in your routers.

export function loginLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:login",
    windowSeconds: 60 * 15,  // 15 min window
    max:           10,        // 10 attempts per IP
  });
}

export function registerLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:register",
    windowSeconds: 60 * 60,  // 1 hr window
    max:           5,         // 5 registrations per IP
  });
}

export function oauthLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:oauth",
    windowSeconds: 60 * 5,   // 5 min window
    max:           20,        // 20 OAuth initiations per IP
  });
}

/**
 * Rate-limited per refresh token, not per IP.
 *
 * Keying this one by IP punishes the wrong thing: a household behind one NAT,
 * or a single client firing several authenticated calls at once after its
 * access token expired, can trip the limit through no fault of its own — and
 * a 429 here reads to a client as "refresh failed", i.e. a sign-out. Per
 * token, the budget is per session, and a client that has to refresh ten
 * times in a minute really is misbehaving. Requests with no token at all
 * still fall back to the IP.
 */
export function refreshLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:refresh",
    windowSeconds: 60,        // 1 min window
    max:           10,        // 10 refresh attempts per session
    keyFn:         (req) => {
      const token = req.cookies?.refresh_token || req.body?.refresh_token;
      if (typeof token === "string" && token.length > 0) {
        return `t:${hashRefreshToken(token)}`;
      }

      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        "unknown";

      return `ip:${ip}`;
    },
  });
}

/** Handing out TV pairing codes. Per IP — nothing is authenticated yet. */
export function deviceStartLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:device:start",
    windowSeconds: 60 * 10,  // 10 min window
    max:           10,        // 10 codes per IP
  });
}

/**
 * Polling for the result, keyed by the *device code* rather than the IP.
 *
 * A TV polls every 5s for up to 10 minutes — 120 requests for one perfectly
 * well-behaved sign-in — and several devices in a household share one NAT, so
 * an IP budget here would throttle the honest case long before the abusive
 * one. Per device code the budget is per pairing attempt, and a caller
 * guessing codes gets a fresh (small) budget only by also guessing a valid
 * 32-byte secret.
 */
export function devicePollLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:device:poll",
    windowSeconds: 60 * 15,  // 15 min window
    max:           200,       // comfortably above 10 min at 5s
    keyFn:         (req) => {
      const code = req.body?.device_code;
      if (typeof code === "string" && code.length > 0) {
        return `d:${hashRefreshToken(code)}`;
      }

      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
        req.socket.remoteAddress ??
        "unknown";

      return `ip:${ip}`;
    },
  });
}

export function shareLimiter(redis: RedisClient) {
  return redisRateLimit({
    redis,
    prefix:        "rl:share",
    windowSeconds: 60 * 5,   // 5 min window
    max:           30,        // 30 shares per user
    keyFn:         (req) => req.user!.sub,
  });
}