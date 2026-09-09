// version.ts
//
// Single source of truth for "what build is this". The human-facing version
// is package.json's semver; the exact build is identified by the git SHA
// baked in at image build time (Dockerfile ARG GIT_SHA -> ENV). Nothing here
// reads .git at runtime — the Docker build context excludes it, and a
// running container has no repo to inspect.
import fs from "node:fs";
import path from "node:path";

interface BuildInfo {
  /** semver from package.json, e.g. "0.2.0" */
  version: string;
  /** short git SHA baked in at build time, or "unknown" outside Docker */
  commit: string;
  /** ISO timestamp of the image build, or null if not stamped */
  builtAt: string | null;
  /** Version of the HTTP API contract clients code against. Bump only on
   *  breaking changes — clients compare against this, not `version`. */
  apiVersion: number;
}

export const API_VERSION = 1;

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** This server's own public base URL, trimmed — includes any reverse-proxy
 *  path prefix (see app/CLAUDE.md "Path-prefixed installs"). Several files
 *  used to each re-derive this from `APP_URL` by hand; this is the one place
 *  now, used wherever a route needs to build a self-referential absolute URL
 *  (e.g. the self-hosted APK download link). */
export function appBaseUrl(): string {
  return (process.env.APP_URL || "http://localhost:3003").replace(/\/+$/, "");
}

/** The reverse-proxy path prefix this install is mounted under, derived from
 *  `APP_URL` — "" for a bare origin, "/streamio" for
 *  `https://host/streamio`. Routes are registered at the root (the proxy
 *  strips the prefix), so nothing server-side needs this — it exists for the
 *  few things the *browser* matches against its own URL. Note that the static
 *  frontend does **not**: every request it makes is root-relative, so this is
 *  deliberately not used to scope the refresh cookie (see
 *  `REFRESH_COOKIE_PATH` in `routes/auth.router.ts` — it only names the legacy
 *  paths to clear). */
export function appBasePath(): string {
  try {
    return new URL(appBaseUrl()).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

const commitRaw = (process.env.GIT_SHA || "").trim();

export const BUILD: BuildInfo = {
  version: readPackageVersion(),
  commit: commitRaw ? commitRaw.slice(0, 7) : "unknown",
  builtAt: process.env.BUILD_TIME?.trim() || null,
  apiVersion: API_VERSION,
};

/** "0.2.0+a1b2c3d" — the string to log and to report to peers/clients. */
export const VERSION_STRING = `${BUILD.version}+${BUILD.commit}`;

// ── semver helpers ───────────────────────────────────────────
// Deliberately tiny: we only ever compare plain X.Y.Z versions that we
// produce ourselves, so a full semver dependency would be overkill.

export function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 if a < b, 0 if equal, 1 if a > b. Unparseable versions compare equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}
