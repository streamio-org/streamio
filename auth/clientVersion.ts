// auth/clientVersion.ts
//
// Rejects native clients whose build is older than the configured floor, so a
// breaking API change can be rolled out without an ancient app silently
// misbehaving against it. Off unless an admin sets `enforce` (see
// PUT /api/settings/client-version) — until then, a too-old client is only
// *told* to update, via /api/version.
//
// Only applies to requests carrying `X-Client: app`; browsers always run the
// frontend this server itself just served, so they're never stale in the way
// this guards against.
import type { Request, Response, NextFunction } from "express";
import type { SettingsService, ClientVersionSettings } from "../services/settings.service.js";
import { compareSemver } from "../version.js";

// Paths a rejected client must still be able to reach — otherwise it can't
// find out why it was rejected or where to get the new build.
const EXEMPT_PREFIXES = ["/api/version", "/health"];

// The policy is read per request, so cache it briefly rather than hitting
// Postgres on every single API call. A few seconds of staleness after an
// admin change is fine for a rollout floor.
const CACHE_TTL_MS = 15_000;

export function createClientVersionGate(settingsService: SettingsService) {
  let cached: ClientVersionSettings | null = null;
  let cachedAt = 0;

  const getPolicy = async (): Promise<ClientVersionSettings> => {
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
    cached = await settingsService.getClientVersionSettings();
    cachedAt = Date.now();
    return cached;
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.header("X-Client") !== "app") return next();
    if (EXEMPT_PREFIXES.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      return next();
    }

    let policy: ClientVersionSettings;
    try {
      policy = await getPolicy();
    } catch (err) {
      // Never lock every client out because the settings lookup failed.
      console.error("[client-version] policy lookup failed:", err);
      return next();
    }

    if (!policy.enforce || !policy.minSupported) return next();

    const version = req.header("X-Client-Version")?.trim();
    // A client too old to send its version at all is, by definition, older
    // than any floor we could set.
    if (version && compareSemver(version, policy.minSupported) >= 0) return next();

    res.status(426).json({
      error: "Upgrade Required",
      message: version
        ? `This app version (${version}) is no longer supported. Please update to continue.`
        : "This app version is no longer supported. Please update to continue.",
      client: {
        current: version ?? null,
        latest: policy.latest,
        minSupported: policy.minSupported,
        downloadUrl: policy.downloadUrl,
        notes: policy.notes,
      },
    });
  };
}
