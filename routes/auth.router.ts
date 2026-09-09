import { Router, type Request, type Response } from "express";
import { AccountService } from "../services/account.service.js";
import {
  buildAuthUrl,
  generateState,
  handleOAuthCallback,
  type OAuthProvider,
} from "../auth/oauth.js";
import { signAccessToken, hashRefreshToken } from "../auth/jwt.js";
import { appBasePath } from "../version.js";
import {
  loginLimiter,
  registerLimiter,
  oauthLimiter,
  refreshLimiter,
  deviceStartLimiter,
  devicePollLimiter,
} from "../auth/rateLimit.js";
import { requireAuth } from "../auth/middleware.js";
import {
  DEVICE_APPROVED_TTL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  deviceCodeMatches,
  deviceKey,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  normalizeUserCode,
  type DeviceLoginRecord,
} from "../auth/deviceLogin.js";
import type { Redis } from "../database/redis.js";
import type { Database } from "../database/db.js";

const OAUTH_PROVIDERS: OAuthProvider[] = ["google", "discord"];

// Pending OAuth states (in-memory; fine for single-instance — use Redis for multi-instance)
const pendingStates = new Map<
  string,
  { provider: OAuthProvider; redirectUri: string | null; redirect: string | null }
>();

// Where /login should send the browser after the round trip (mirrors the
// `?redirect=` param apiFetch's redirectToLogin sets). Only ever a same-site
// path — never an absolute/protocol-relative URL — since this value is
// reflected straight into a redirect Location.
function isAllowedRedirect(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

// Custom scheme the Flutter app registers for its OAuth callback. Native
// clients can't receive an httpOnly cookie, so the OAuth redirect carries
// both tokens in the query string — only ever to this exact allowlisted
// target (or the configured APP_URL), never to a caller-supplied origin.
const APP_OAUTH_REDIRECT = "streamio://auth";

function isAllowedRedirectUri(uri: string): boolean {
  if (uri === APP_OAUTH_REDIRECT) return true;
  const appUrl = process.env.APP_URL;
  return Boolean(appUrl) && uri.startsWith(`${appUrl}/`);
}

/**
 * Native clients (the Flutter app) send `X-Client: app`. They have no cookie
 * jar tied to a browser session, so they also get the refresh token in the
 * JSON body and may send it back in the request body. Browsers are
 * unaffected: they keep using the httpOnly cookie and never see the token.
 */
function isAppClient(req: Request): boolean {
  const header = req.get("x-client");
  return typeof header === "string" && header.toLowerCase() === "app";
}

function readRefreshToken(req: Request): string | undefined {
  return req.cookies?.refresh_token || (isAppClient(req) ? req.body?.refresh_token : undefined);
}

/**
 * One line per refresh attempt, describing what the *client* actually sent.
 *
 * A session that dies on schedule looks identical from the outside whatever
 * the cause — the browser silently not sending a cookie, sending a stale one,
 * or a proxy dropping the header on the way in — and none of them leave a
 * trace in `refresh_tokens`, since a refresh that never reaches rotation
 * writes nothing at all. Logging the shape of the request (never the token
 * itself, only a short hash prefix) is what separates them.
 */
function logRefreshAttempt(req: Request, outcome: string) {
  const cookieHeader = req.get("cookie");
  const names = Object.keys(req.cookies ?? {});
  const raw = readRefreshToken(req);

  console.log(
    "[auth/refresh]",
    JSON.stringify({
      outcome,
      hasCookieHeader: Boolean(cookieHeader),
      cookieNames: names,
      // A same-named cookie left at another path arrives as a duplicate and
      // shadows the good one — visible here and nowhere else.
      duplicateRefreshCookie: (cookieHeader?.match(/(^|[;\s])refresh_token=/g) ?? []).length > 1,
      token: raw ? hashRefreshToken(raw).slice(0, 8) : null,
      client: isAppClient(req) ? "app" : "browser",
      proto: req.get("x-forwarded-proto") ?? null,
      ua: (req.get("user-agent") ?? "").slice(0, 60),
    }),
  );
}

/**
 * Scope of the refresh cookie, as the *browser* sees it: the whole origin.
 *
 * Narrower scoping cannot work here, because the browser matches a cookie's
 * `path` against the URL it actually requested and the two clients disagree
 * about what that is. The web frontend asks for `/api/auth/refresh`
 * root-relative (`fetch("/api/auth/refresh")` in `public/scripts/auth.js`), so
 * on a path-prefixed install (`APP_URL=https://host/streamio`) the request
 * goes to `/api/auth/refresh` while a prefix-derived cookie sits at
 * `/streamio/api/auth/refresh` and is never sent — login works, then the
 * session silently dies the moment the 15-minute access token expires and
 * every refresh 401s with no token at all. Deriving the path from `APP_URL`
 * fixes a proxy that rewrites the prefix onto the request and breaks one that
 * doesn't; `/` is correct under both, and is also the only scope that reaches
 * `/api/auth/logout`, which otherwise could never revoke the token it was
 * asked to revoke.
 */
const REFRESH_COOKIE_PATH = "/";

/**
 * Paths earlier builds scoped the cookie to. A browser sends *every* matching
 * cookie of the same name, most-specific path first, so a leftover cookie at
 * one of these would shadow the `/`-scoped one on the refresh route forever —
 * and it holds a token that rotation has already retired. Cleared alongside
 * every set, so an existing session migrates on its next refresh instead of
 * being wedged.
 */
const LEGACY_REFRESH_COOKIE_PATHS = Array.from(
  new Set([`${appBasePath()}/api/auth/refresh`, "/api/auth/refresh"]),
);

function clearLegacyRefreshCookies(res: Response) {
  for (const path of LEGACY_REFRESH_COOKIE_PATHS) {
    res.clearCookie("refresh_token", { path });
  }
}

const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge:   1000 * 60 * 60 * 24 * 30, // 30 days
  path:     REFRESH_COOKIE_PATH,
};

function sendTokens(
  req: Request,
  res: Response,
  accessToken: string,
  refreshToken: string,
  /**
   * Extra body fields, for callers whose response is more than a session —
   * the TV poll answers the same shape whether it is still waiting or done,
   * and says which in `status`.
   */
  extra: Record<string, unknown> = {}
) {
  // Refresh token in httpOnly cookie; access token in body
  clearLegacyRefreshCookies(res);
  res.cookie("refresh_token", refreshToken, REFRESH_COOKIE_OPTIONS);

  // Pairs with [auth/refresh] above: a session that keeps reappearing here
  // rather than rotating is being re-created by a fresh login every time.
  console.log(
    "[auth/issue]",
    JSON.stringify({
      token: hashRefreshToken(refreshToken).slice(0, 8),
      path: REFRESH_COOKIE_PATH,
      secure: REFRESH_COOKIE_OPTIONS.secure,
      client: isAppClient(req) ? "app" : "browser",
      proto: req.get("x-forwarded-proto") ?? null,
    }),
  );

  res.json({
    ...extra,
    access_token: accessToken,
    ...(isAppClient(req) ? { refresh_token: refreshToken } : {}),
  });
}

/**
 * A browser OAuth login cannot be completed with a cookie set by the callback.
 *
 * The provider redirects to `redirectUri()` (`auth/oauth.ts`), which is built
 * from `APP_URL` and must match what is registered with Google/Discord exactly
 * — so the callback always lands on the `APP_URL` origin, whatever origin the
 * user is actually browsing. Those two can differ for a reverse-proxied
 * install — e.g. a public hostname or tunnel in front of the app that isn't
 * exactly `APP_URL`. So the callback would set the refresh cookie on the
 * `APP_URL` host while the user ends up on a different host, and a server can
 * only ever set a cookie for the host it was contacted on. The two cookie
 * jars never meet: the session then lives exactly as long as the 15-minute
 * access token, every single time, and the refresh arrives carrying no
 * cookie at all.
 *
 * So the callback hands back a single-use code instead, and the *page* trades
 * it for a session by POSTing to its own origin — which is, by construction,
 * an origin whose cookie the browser will keep sending. The code is worth a
 * session for 60 seconds and only once; it rides the URL exactly where the
 * access token used to, and is strictly less exposed than what it replaces.
 *
 * Native clients skip all of this: they can't do a same-origin POST, and they
 * receive both tokens in the redirect query as before.
 */
const OAUTH_HANDOFF_TTL_SECONDS = 60;

function handoffKey(code: string): string {
  return `oauth:handoff:${code}`;
}

export function createAuthRouter(db: Database, redis: Redis): Router {
  const router  = Router();
  const service = new AccountService(db, redis);

  // ── POST /api/auth/register ───────────────────────────────
  router.post(
    "/register",
    registerLimiter(redis),
    async (req: Request, res: Response) => {
      const { email, password, display_name } = req.body;

      if (!email || !password) {
        res.status(400).json({ error: "email and password are required." });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters." });
        return;
      }

      try {
        const user = await service.register(email, password, display_name);

        const refreshToken = await service.createRefreshToken(user.id);
        const accessToken  = signAccessToken({ sub: user.id, email: user.email });

        sendTokens(req, res.status(201), accessToken, refreshToken);
      } catch (err: any) {
        if (err.message === "EMAIL_TAKEN") {
          res.status(409).json({ error: "Email already in use." });
          return;
        }
        throw err;
      }
    }
  );

  // ── POST /api/auth/login ──────────────────────────────────
  router.post(
    "/login",
    loginLimiter(redis),
    async (req: Request, res: Response) => {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ error: "email and password are required." });
        return;
      }

      try {
        const user = await service.loginWithPassword(email, password);

        const refreshToken = await service.createRefreshToken(user.id);
        const accessToken  = signAccessToken({ sub: user.id, email: user.email });

        sendTokens(req, res, accessToken, refreshToken);
      } catch (err: any) {
        if (err.message === "INVALID_CREDENTIALS") {
          res.status(401).json({ error: "Invalid email or password." });
          return;
        }
        throw err;
      }
    }
  );

  // ── POST /api/auth/refresh ────────────────────────────────
  router.post(
    "/refresh",
    refreshLimiter(redis),
    async (req: Request, res: Response) => {
      const rawToken = readRefreshToken(req);

      if (!rawToken) {
        logRefreshAttempt(req, "no-token");
        res.status(401).json({ error: "No refresh token provided." });
        return;
      }

      try {
        const { user, newRawToken } = await service.rotateRefreshToken(rawToken);
        const accessToken = signAccessToken({ sub: user.id, email: user.email });

        logRefreshAttempt(req, "rotated");
        sendTokens(req, res, accessToken, newRawToken);
      } catch {
        logRefreshAttempt(req, "rejected");
        res.clearCookie("refresh_token", { path: REFRESH_COOKIE_PATH });
        clearLegacyRefreshCookies(res);
        res.status(401).json({ error: "Invalid or expired refresh token." });
      }
    }
  );

  // ── POST /api/auth/logout ─────────────────────────────────
  router.post("/logout", async (req: Request, res: Response) => {
    const rawToken = readRefreshToken(req);

    if (rawToken) {
      await service.revokeRefreshToken(rawToken).catch(() => {});
    }

    res.clearCookie("refresh_token", { path: REFRESH_COOKIE_PATH });
    clearLegacyRefreshCookies(res);
    res.json({ message: "Logged out." });
  });

  // ── POST /api/auth/verify-email ───────────────────────────
  // Consumes the token `register()` mails out. `public/verify-email.html`
  // (and the app's verify-email screen) have always POSTed here; the route
  // itself was missing, so the link in the email 404'd.
  router.post("/verify-email", async (req: Request, res: Response) => {
    const { token } = req.body ?? {};

    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token is required." });
      return;
    }

    try {
      await service.verifyEmail(token);
      res.json({ message: "Email verified." });
    } catch {
      res.status(400).json({
        error:
          "That verification link is invalid, expired, or already used. " +
          "Request a new one to try again.",
      });
    }
  });

  // ── POST /api/auth/verify-email/resend ────────────────────
  // Re-issues a verification token and mails a fresh link. A link's host is
  // whatever public URL the server had when it was sent, and behind the
  // Cloudflare tunnel that hostname changes on every restart — so a user can
  // end up holding a dead link having done nothing wrong.
  // Always 200, same email-enumeration reasoning as password-reset/request.
  router.post(
    "/verify-email/resend",
    loginLimiter(redis),
    async (req: Request, res: Response) => {
      const { email } = req.body ?? {};
      if (!email) {
        res.status(400).json({ error: "email is required." });
        return;
      }

      await service.resendVerificationEmail(email).catch(() => {});
      res.json({ message: "If that account needs verifying, a new link has been sent." });
    }
  );

  // ── POST /api/auth/password-reset/request ─────────────────
  router.post(
    "/password-reset/request",
    loginLimiter(redis),
    async (req: Request, res: Response) => {
      const { email } = req.body;
      if (!email) {
        res.status(400).json({ error: "email is required." });
        return;
      }
      // Always 200 to avoid email enumeration
      await service.requestPasswordReset(email).catch(() => {});
      res.json({ message: "If that email exists, a reset link has been sent." });
    }
  );

  // ── POST /api/auth/password-reset/confirm ─────────────────
  router.post(
    "/password-reset/confirm",
    async (req: Request, res: Response) => {
      const { token, password } = req.body;
      if (!token || !password) {
        res.status(400).json({ error: "token and password are required." });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters." });
        return;
      }

      try {
        await service.resetPassword(token, password);
        res.json({ message: "Password updated successfully." });
      } catch {
        res.status(400).json({ error: "Invalid or expired reset token." });
      }
    }
  );

  // ── POST /api/auth/oauth/exchange ─────────────────────────
  // Trades the single-use code from the OAuth callback for a real session.
  // The whole point is *where* this runs: the page calls it on its own
  // origin, so the refresh cookie is finally set on the host the browser is
  // actually on. Registered above `/:provider` — that route would otherwise
  // swallow "oauth" as a provider name.
  router.post("/oauth/exchange", async (req: Request, res: Response) => {
    const { code } = req.body ?? {};

    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "code is required." });
      return;
    }

    const userId = await redis.get<string>(handoffKey(code));
    if (!userId) {
      res.status(401).json({ error: "Invalid or expired login code." });
      return;
    }
    // Single use: burn it before minting anything, so a replayed or shared
    // URL is worthless even if it arrives within the TTL.
    await redis.delete(handoffKey(code));

    // getUserById throws USER_NOT_FOUND rather than returning null — an
    // account deleted inside the 60s window must read as a dead code, not a
    // 500 from the global error handler.
    let user;
    try {
      user = await service.getUserById(userId);
    } catch {
      res.status(401).json({ error: "Invalid or expired login code." });
      return;
    }

    const refreshToken = await service.createRefreshToken(user.id);
    const accessToken  = signAccessToken({ sub: user.id, email: user.email });

    sendTokens(req, res, accessToken, refreshToken);
  });

  // ── POST /api/auth/device/start ───────────────────────────
  // Begins a TV sign-in. Unauthenticated by definition: the whole point is
  // that this device has no way to authenticate anyone yet. See
  // `auth/deviceLogin.ts` for why there are two codes and which one is the
  // secret. Registered above `/:provider` for the same reason
  // `/oauth/exchange` is — that route would read "device" as a provider name.
  router.post("/device/start", deviceStartLimiter(redis), async (req: Request, res: Response) => {
    const rawLabel = typeof req.body?.label === "string" ? req.body.label.trim() : "";
    const label = rawLabel ? rawLabel.slice(0, 60) : null;

    // Collisions are vanishingly unlikely but not impossible, and reusing a
    // live code would hand the earlier device's pairing to this one.
    let userCode: string | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateUserCode();
      if (!(await redis.exists(deviceKey(candidate)))) {
        userCode = candidate;
        break;
      }
    }

    if (!userCode) {
      res.status(503).json({ error: "Could not allocate a sign-in code. Try again." });
      return;
    }

    const deviceCode = generateDeviceCode();
    const record: DeviceLoginRecord = {
      deviceCodeHash: hashDeviceCode(deviceCode),
      status: "pending",
      userId: null,
      label,
    };
    await redis.set(deviceKey(userCode), record, DEVICE_CODE_TTL_SECONDS);

    // APP_URL, not the request's own host: this URL is read off a television
    // and typed into a phone, so it has to be the install's public address —
    // and it must carry the path prefix on a path-prefixed install.
    const appUrl = process.env.APP_URL ?? "http://localhost:3003";
    const verificationUri = `${appUrl}/tv`;
    const complete = new URL(verificationUri);
    complete.searchParams.set("code", userCode);

    res.json({
      user_code: userCode,
      device_code: deviceCode,
      verification_uri: verificationUri,
      verification_uri_complete: complete.toString(),
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  });

  // ── POST /api/auth/device/token ───────────────────────────
  // The TV asking "has anyone approved me yet?". Answers 200 either way —
  // `status: "pending"` while it waits, a real session once approved — so the
  // app can treat a non-200 as an actual failure.
  router.post("/device/token", devicePollLimiter(redis), async (req: Request, res: Response) => {
    const { device_code: deviceCode, user_code: userCode } = req.body ?? {};

    if (typeof deviceCode !== "string" || typeof userCode !== "string") {
      res.status(400).json({ error: "device_code and user_code are required." });
      return;
    }

    const key = deviceKey(normalizeUserCode(userCode));
    const record = await redis.get<DeviceLoginRecord>(key);

    // Expired or already redeemed. Distinct from "pending" so the TV can show
    // a fresh code instead of polling a record that will never resolve.
    if (!record) {
      res.status(410).json({ status: "expired", error: "This sign-in code has expired." });
      return;
    }

    // The user code is public — it is on a screen. This is the check that
    // makes reading it off someone's television worthless.
    if (!deviceCodeMatches(deviceCode, record.deviceCodeHash)) {
      res.status(403).json({ error: "Invalid device code." });
      return;
    }

    if (record.status !== "approved" || !record.userId) {
      res.json({ status: "pending" });
      return;
    }

    // Single use: burn it before minting anything, exactly as the OAuth
    // handoff code does.
    await redis.delete(key);

    let user;
    try {
      user = await service.getUserById(record.userId);
    } catch {
      res.status(401).json({ error: "That account is no longer available." });
      return;
    }

    const refreshToken = await service.createRefreshToken(user.id);
    const accessToken  = signAccessToken({ sub: user.id, email: user.email });

    sendTokens(req, res, accessToken, refreshToken, { status: "approved" });
  });

  // ── POST /api/auth/device/claim ───────────────────────────
  // The phone half: a signed-in browser binding its own account to the code on
  // the television. requireAuth is the entire security model of the approval
  // step — whoever is signed in here is the account the TV receives.
  router.post("/device/claim", requireAuth, async (req: Request, res: Response) => {
    const rawCode = req.body?.user_code;
    if (typeof rawCode !== "string" || !rawCode.trim()) {
      res.status(400).json({ error: "user_code is required." });
      return;
    }

    const key = deviceKey(normalizeUserCode(rawCode));
    const record = await redis.get<DeviceLoginRecord>(key);

    if (!record) {
      res.status(404).json({ error: "That code has expired. Start again on your TV." });
      return;
    }

    if (record.status === "approved") {
      res.status(409).json({ error: "That code has already been used." });
      return;
    }

    const approved: DeviceLoginRecord = {
      ...record,
      status: "approved",
      userId: req.user!.sub,
    };
    // Deliberately a shorter TTL than the pending record had: from here on it
    // is worth a session to whoever holds the device code, and the TV is
    // polling every few seconds.
    await redis.set(key, approved, DEVICE_APPROVED_TTL_SECONDS);

    res.json({ message: "Your TV is signed in.", label: record.label });
  });

  // ── GET /api/auth/:provider ───────────────────────────────
  router.get(
    "/:provider",
    oauthLimiter(redis),
    (req: Request, res: Response) => {
      const provider = req.params.provider as OAuthProvider;

      if (!OAUTH_PROVIDERS.includes(provider)) {
        res.status(404).json({ error: "Unknown provider." });
        return;
      }

      // Native clients pass ?redirect_uri=streamio://auth so the callback
      // lands back in the app instead of the web frontend. Anything not on
      // the allowlist is ignored (falls back to APP_URL/auth/callback).
      const requested = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
      const redirectUri = requested && isAllowedRedirectUri(requested) ? requested : null;

      // Where the /login page wants to land the user afterward (set by
      // login.js from its own `?redirect=` param, e.g. after auth.js bounced
      // an expired session here). Browser flow only — native clients use
      // redirectUri above instead.
      const requestedRedirect = typeof req.query.redirect === "string" ? req.query.redirect : "";
      const redirect = requestedRedirect && isAllowedRedirect(requestedRedirect) ? requestedRedirect : null;

      const state = generateState();
      pendingStates.set(state, { provider, redirectUri, redirect });

      // Clean up stale states after 10 min
      setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000);

      res.redirect(buildAuthUrl(provider, state));
    }
  );

  // ── GET /api/auth/:provider/callback ─────────────────────
  router.get(
    "/:provider/callback",
    async (req: Request, res: Response) => {
      const provider = req.params.provider as OAuthProvider;
      const { code, state, error } = req.query as Record<string, string>;

      if (error) {
        res.status(400).json({ error: `OAuth error: ${error}` });
        return;
      }

      if (!OAUTH_PROVIDERS.includes(provider)) {
        res.status(404).json({ error: "Unknown provider." });
        return;
      }

      // Validate CSRF state
      const pending = state ? pendingStates.get(state) : undefined;
      if (!pending || pending.provider !== provider) {
        res.status(400).json({ error: "Invalid OAuth state." });
        return;
      }
      pendingStates.delete(state);

      if (!code) {
        res.status(400).json({ error: "No authorization code received." });
        return;
      }

      try {
        const profile = await handleOAuthCallback(provider, code);
        const user    = await service.upsertOAuthUser(profile);

        // Native clients also need the refresh token here: a cookie set on
        // this response lands in a browser tab the app throws away, so
        // without it the app could never refresh and would be logged out in
        // 15 min. Unchanged from before the handoff code existed.
        if (pending.redirectUri) {
          const refreshToken = await service.createRefreshToken(user.id);
          const accessToken  = signAccessToken({ sub: user.id, email: user.email });

          clearLegacyRefreshCookies(res);
          res.cookie("refresh_token", refreshToken, REFRESH_COOKIE_OPTIONS);

          const target = new URL(pending.redirectUri);
          target.searchParams.set("token", accessToken);
          target.searchParams.set("refresh", refreshToken);
          res.redirect(target.toString());
          return;
        }

        // Browser: no tokens are minted here at all, because nothing issued
        // on this origin would be usable on the one the user lands on.
        const handoff = generateState();
        await redis.set(handoffKey(handoff), user.id, OAUTH_HANDOFF_TTL_SECONDS);

        const appUrl = process.env.APP_URL ?? "http://localhost:3003";
        const callbackUrl = new URL(`${appUrl}/auth/callback`);
        callbackUrl.searchParams.set("code", handoff);
        if (pending.redirect) callbackUrl.searchParams.set("redirect", pending.redirect);
        res.redirect(callbackUrl.toString());
      } catch (err: any) {
        // An unverified address at the provider is a refusal, not a failure:
        // matching an OAuth identity to a local account by an address nobody
        // proved is how an attacker signs in as somebody else. See
        // AccountService.upsertOAuthUser.
        if (err?.message === "OAUTH_EMAIL_UNVERIFIED") {
          res.status(403).json({
            error:
              `Your ${provider} account's email address hasn't been verified with ${provider}. ` +
              `Verify it there, or sign in with an email and password instead.`,
          });
          return;
        }
        if (err?.message === "OAUTH_EMAIL_MISSING") {
          res.status(400).json({
            error: `Your ${provider} account didn't share an email address, which is required to sign in.`,
          });
          return;
        }
        console.error(`[OAuth:${provider}] Full error:`, err);
        res.status(500).json({ error: "Authentication failed.", detail: err.message });
      }
    }
  );

  return router;
}