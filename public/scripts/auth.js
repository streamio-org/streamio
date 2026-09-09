/**
 * auth.js — shared token management for Streamio
 *
 * The server issues:
 *   - access token  → JSON body  { access_token: "..." }   (short-lived JWT)
 *   - refresh token → httpOnly cookie                       (30 days)
 *
 * We keep the access token in sessionStorage so it survives page
 * navigation within the tab but is discarded when the tab closes.
 * The refresh token is handled entirely by the browser cookie jar.
 */

const ACCESS_KEY = "streamio.access_token";

export function saveAccessToken(token) {
  if (token) sessionStorage.setItem(ACCESS_KEY, token);
}

export function getAccessToken() {
  return sessionStorage.getItem(ACCESS_KEY);
}

export function clearAccessToken() {
  sessionStorage.removeItem(ACCESS_KEY);
}

let refreshInFlight = null;

/**
 * One refresh at a time. The server rotates the refresh token on use, so a
 * page that fires several authenticated calls at once (every one of them 401
 * after the 15-minute access token expires) would otherwise send the same
 * cookie through rotation several times over and race with itself.
 */
function attemptRefresh() {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * Returns `{ token, dead }`. `dead` is true only when the server itself
 * rejected the refresh token (401/403) — the one case that really means
 * "log in again". A 429 from the refresh rate limiter, a 5xx, an offline
 * moment or a proxy hiccup leave `dead` false: the session is still good and
 * the call is simply worth retrying. Treating those as a sign-out is what
 * kicked people back to the login page at random.
 */
async function doRefresh() {
  let res;
  try {
    res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",  // sends the httpOnly cookie
    });
  } catch {
    return { token: null, dead: false };
  }

  if (res.ok) {
    const { access_token } = await res.json().catch(() => ({}));
    if (!access_token) return { token: null, dead: false };
    saveAccessToken(access_token);
    return { token: access_token, dead: false };
  }

  return { token: null, dead: res.status === 401 || res.status === 403 };
}

/**
 * Call /api/auth/refresh to get a new access token using the httpOnly
 * refresh-token cookie.  Returns the new access token string, or null
 * on failure (cookie missing / expired / revoked).
 */
export async function refreshAccessToken() {
  return (await attemptRefresh()).token;
}

/**
 * Restore the session without ever forcing a login.
 *
 * The content pages (home, catalog, search, providers, details) are browsable
 * logged out, but the server still needs to recognise a signed-in visitor —
 * that's how it knows whether to serve 18+ content. A fresh tab has an empty
 * sessionStorage even when the refresh cookie is perfectly good, so without
 * this the first page load always looks anonymous.
 *
 * Never throws and never redirects: failing just means browsing as a guest.
 */
export async function ensureSessionQuietly() {
  if (getAccessToken()) return;
  await attemptRefresh().catch(() => {});
}

/**
 * fetch for endpoints that serve both guests and signed-in users.
 *
 * Sends the access token when there is one, so the server can personalise the
 * response, but — unlike `apiFetch` — never refreshes and never bounces to
 * /login, because a logged-out visitor browsing the catalogue is a perfectly
 * normal state rather than an error.
 */
export function fetchPublic(url, options = {}) {
  const token = getAccessToken();

  return fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/**
 * Authenticated fetch wrapper.
 *
 * - Attaches Authorization: Bearer <token> automatically.
 * - On 401, attempts a silent token refresh once, then retries.
 * - On second 401, clears tokens and redirects to /login.
 *
 * A refresh that fails for any reason other than the server rejecting the
 * token throws, leaving the session alone — the page shows an error, and the
 * next call can still succeed.
 *
 * Usage:
 *   import { apiFetch } from "/auth.js";
 *   const data = await apiFetch("/api/account/me");
 */
export async function apiFetch(url, options = {}) {
  let token = getAccessToken();

  // If we have no token at all, try a silent refresh before the first call.
  if (!token) {
    const attempt = await attemptRefresh();
    if (!attempt.token) {
      if (attempt.dead) {
        redirectToLogin();
        throw new Error("Not authenticated");
      }
      throw new Error("Could not reach the server to renew the session.");
    }
    token = attempt.token;
  }

  const res = await fetchWithToken(url, options, token);

  if (res.status !== 401) return res;

  // Access token expired — try refresh once
  const attempt = await attemptRefresh();
  if (!attempt.token) {
    if (attempt.dead) {
      redirectToLogin();
      throw new Error("Session expired");
    }
    throw new Error("Could not renew the session. Please try again.");
  }
  token = attempt.token;

  const retried = await fetchWithToken(url, options, token);
  if (retried.status === 401) {
    redirectToLogin();
    throw new Error("Session expired");
  }
  return retried;
}

function fetchWithToken(url, options, token) {
  // FormData (file uploads) must not get a hand-set Content-Type — the
  // browser needs to add its own multipart boundary — and must not be
  // JSON.stringify'd, which would turn the File into "[object File]".
  const isFormData = options.body instanceof FormData;
  return fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
    body: isFormData || typeof options.body === "string"
      ? options.body
      : options.body
        ? JSON.stringify(options.body)
        : options.body,
  });
}

function redirectToLogin() {
  clearAccessToken();
  const here = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?redirect=${here}`;
}

/**
 * Logout: revoke the refresh token on the server, clear local state,
 * redirect to /login.
 */
export async function logout() {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  }).catch(() => {});
  clearAccessToken();
  window.location.href = "/login";
}

/**
 * Convenience JSON wrapper around apiFetch.
 * Throws on non-2xx with the server's { error } message.
 */
export async function api(url, options = {}) {
  const res = await apiFetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The status and the server's own `reason` ride along on the error.
    // Without them every caller can only tell "it failed", which is how a
    // transient 503 and a deliberate 403 end up handled the same way — the
    // admin probes hid the panel on both.
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.reason = data.reason || null;
    err.data = data;
    throw err;
  }
  return data;
}

let cachedSelfId = null;

/** Current user's id, fetched once per page load and cached. Null if logged out. */
export async function getSelfId() {
  if (cachedSelfId || !getAccessToken()) return cachedSelfId;
  try {
    const me = await api("/api/account/me");
    cachedSelfId = me?.id || null;
  } catch {
    cachedSelfId = null;
  }
  return cachedSelfId;
}

// Library rows are cached per (provider, show_id) pair, keyed by a string
// because objects can't key a plain cache. Both halves live in one helper so
// the format is defined once.
export function showKey(provider, showId) {
  return `${provider}:${showId}`;
}

// Splits on the FIRST colon only. A provider slug never contains one, but a
// show id may: ids are opaque strings minted by whichever provider produced
// them, and some are (or were) URLs. Splitting on every colon truncated such
// an id to "https", which reached the provider and was fetched as a path.
export function parseShowKey(key) {
  const at = String(key ?? "").indexOf(":");
  if (at < 0) return { provider: key, showId: "" };
  return { provider: key.slice(0, at), showId: key.slice(at + 1) };
}

export function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}