import { Router, type Request, type Response } from "express";
import type { Database } from "../database/db.js";
import { SettingsService } from "../services/settings.service.js";
import { APK_PATH } from "../services/apk-storage.js";
import { BUILD, appBaseUrl, compareSemver } from "../version.js";
import { verifyAccessToken } from "../auth/jwt.js";

// Public, unauthenticated: a client that is too old to authenticate still has
// to be able to find out that it's too old, and what to do about it. This is
// also the endpoint the client-version gate exempts, for the same reason.
export function createVersionRouter(db: Database): Router {
  const router = Router();
  const settings = new SettingsService(db);

  router.get("/", async (req: Request, res: Response) => {
    const policy = await settings.getClientVersionSettings();

    // Clients send their own build so the server can answer "do *you* need to
    // update" directly, instead of every client re-implementing the compare.
    const clientVersion = req.header("X-Client-Version")?.trim() || null;
    const updateRequired =
      clientVersion !== null &&
      policy.minSupported !== null &&
      compareSemver(clientVersion, policy.minSupported) < 0;
    const updateAvailable =
      clientVersion !== null &&
      policy.latest !== null &&
      compareSemver(clientVersion, policy.latest) < 0;

    res.json({
      server: {
        version: BUILD.version,
        commit: BUILD.commit,
        builtAt: BUILD.builtAt,
      },
      api: {
        version: BUILD.apiVersion,
      },
      client: {
        latest: policy.latest,
        minSupported: policy.minSupported,
        downloadUrl: policy.downloadUrl,
        notes: policy.notes,
        // null when the client didn't identify itself — the client then
        // decides for itself from latest/minSupported.
        current: clientVersion,
        updateAvailable: clientVersion === null ? null : updateAvailable,
        updateRequired: clientVersion === null ? null : updateRequired,
        enforced: policy.enforce,
      },
    });
  });

  // Serves the self-hosted APK, when `downloadUrl` actually points here —
  // mounted under /api/version so it inherits that path's exemption from
  // the client-version gate (auth/clientVersion.ts): a build already
  // rejected with 426 still has to be able to reach the file that fixes it.
  // Still requires a logged-in user, though — this keeps the APK from being
  // freely downloadable by anyone who finds the URL.
  //
  // Two ways in: an `Authorization: Bearer` header (the app, or any other
  // API client that already holds a token) or a `?token=` query param — the
  // same fallback the room WebSocket uses (services/room-socket.service.ts),
  // for the same reason: a plain browser navigation to this URL can't set a
  // header. A browser hitting it with neither is sent to /login, which
  // (login.js) appends the freshly issued access token back onto the
  // `redirect` target when it's this endpoint, then completes the
  // navigation — so the file starts downloading right after sign-in.
  router.get("/download", async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const queryToken = typeof req.query.token === "string" ? req.query.token : null;
    const token = bearerToken || queryToken;

    let authed = false;
    if (token) {
      try {
        verifyAccessToken(token);
        authed = true;
      } catch {
        authed = false;
      }
    }

    if (!authed) {
      // A real API client (Authorization header present but invalid/expired)
      // gets a normal 401 — only a bare, credential-less request is treated
      // as a browser that can be sent through the login page.
      if (bearerToken) {
        res.status(401).json({ error: "Unauthorized", message: "Invalid or expired access token." });
        return;
      }
      // Absolute, via appBaseUrl(), not a bare `/login`. A root-relative
      // Location is resolved by the browser against the *origin*, which drops
      // any reverse-proxy path prefix this install is mounted under — on a
      // `https://host/streamio` install that lands on whatever else the host
      // serves at `/`, not on Streamio's login page. The `redirect` param
      // stays root-relative on purpose: it is resolved against whatever origin
      // ends up serving the login page (e.g. a tunnel's own hostname, where
      // the app is mounted at the root), and login.js matches it literally in
      // `withDownloadToken`.
      res.redirect(`${appBaseUrl()}/login?redirect=${encodeURIComponent("/api/version/download")}`);
      return;
    }

    const policy = await settings.getClientVersionSettings();
    if (policy.downloadUrl !== `${appBaseUrl()}/api/version/download`) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.download(APK_PATH, "streamio.apk", (err) => {
      // A mid-stream failure (client disconnect, etc.) can't send a fresh
      // response — only answer if nothing has gone out yet (e.g. the file
      // is missing despite downloadUrl pointing here).
      if (err && !res.headersSent) res.status(404).json({ error: "Build not found." });
    });
  });

  return router;
}
