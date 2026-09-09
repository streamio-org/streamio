// core/utils/ssrf.ts
//
// Guard for every outbound fetch whose URL came, even indirectly, from a
// client: `/api/cast-proxy?url=` and the `server` object POSTed to
// `/api/episodes/:id/video`.
//
// Those endpoints exist to fetch *upstream streaming hosts* on the caller's
// behalf, and the caller supplies the absolute URL — which without a check is
// an unauthenticated request-forgery proxy into whatever the container can
// reach: the cloud metadata service (169.254.169.254), `redis`/`db` on the
// compose network, or anything bound to localhost.
//
// Four things are checked, and all four are needed:
//   1. the scheme is http(s) — no file:, gopher:, data:, ...
//   2. every address the hostname resolves to is publicly routable
//   3. the same holds after each redirect — an allowed host that 302s to
//      169.254.169.254 would otherwise walk straight past checks 1 and 2,
//      because `fetch` follows redirects itself and only reports the last hop
//   4. the socket connects to *the addresses that were checked*, and to
//      nothing else
//
// (4) is what makes the other three worth anything, and it is the one that is
// easy to leave out. Validating a hostname and then handing the *name* to
// `fetch`/axios means the name is resolved a second time, and a hostname whose
// record is served with TTL 0 can answer the first lookup with a public
// address and the second with 127.0.0.1 — classic DNS rebinding, repeatable
// until it lands. So resolution happens exactly once, in `guardedLookup`,
// which validates what it resolved and hands those addresses to the socket:
//   • `safeFetch` fetches through `guardedDispatcher` (undici)
//   • every axios client in `core/` spreads `guardedAgents`
// That also closes the redirect hole for callers that do *not* chase redirects
// by hand: axios follows up to 21 by default, and each hop opens a socket
// through the same guarded lookup, so hop 6 is checked exactly like hop 1.
//
// A self-hosted install that genuinely needs to proxy something on its own LAN
// (a local IPTV box, a media server on 192.168.x.x) can set
// ALLOW_PRIVATE_UPSTREAM=1 to skip the address check. The scheme check, the
// single-resolution rule and the redirect chase stay on regardless.

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici";

/** Thrown for a URL this process refuses to fetch on a caller's behalf. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function allowPrivateUpstream(): boolean {
  // Read per call, not once at import: tests and `dotenv` both set this after
  // some modules have already been loaded.
  return process.env.ALLOW_PRIVATE_UPSTREAM === "1";
}

// ── Address classification ───────────────────────────────────

/**
 * IPv4 ranges that are not publicly routable, plus the ones that are routable
 * but only ever interesting to an attacker (link-local carries the cloud
 * metadata service; 100.64/10 is carrier-grade NAT, i.e. the host's own LAN on
 * many networks).
 */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local — cloud metadata lives here
  ["172.16.0.0", 12],    // RFC1918
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.88.99.0", 24],   // 6to4 relay anycast
  ["192.168.0.0", 16],   // RFC1918
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, incl. 255.255.255.255
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable — fail closed

  for (const [base, bits] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return true;
  }
  return false;
}

/**
 * IPv6 text → 16 bytes, or null if it doesn't parse. Only ever called on
 * strings `net.isIPv6` already accepted, so this handles the shapes that
 * implies — `::` compression and a trailing embedded IPv4 literal.
 */
function ipv6ToBytes(ip: string): Uint8Array | null {
  let text = ip;

  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);

  // "::ffff:1.2.3.4" — fold the dotted quad into the two hex groups it stands
  // for, so the group logic below doesn't need a special case.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const quad = tail.split(".").map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    text =
      text.slice(0, lastColon + 1) +
      (((quad[0]! << 8) | quad[1]!).toString(16)) +
      ":" +
      (((quad[2]! << 8) | quad[3]!).toString(16));
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];

  let groups: string[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill("0"), ...rest];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const value = parseInt(groups[i] || "0", 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function embeddedV4(bytes: Uint8Array, offset: number): string {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

function isPrivateIpv6(ip: string): boolean {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable — fail closed

  // ::/96 — "::", "::1", and the deprecated IPv4-compatible form, plus the
  // IPv4-mapped ::ffff:a.b.c.d that a dual-stack resolver hands back.
  if (b.slice(0, 10).every((x) => x === 0)) {
    if (b[10] === 0xff && b[11] === 0xff) return isPrivateIpv4(embeddedV4(b, 12));
    // "::" and "::1" both live inside 0.0.0.0/8 and 127.0.0.0/8 once read as
    // an embedded v4, so the same table answers them.
    return isPrivateIpv4(embeddedV4(b, 12));
  }
  if ((b[0]! & 0xfe) === 0xfc) return true;                       // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;      // fe80::/10 link-local
  if (b[0] === 0xff) return true;                                 // ff00::/8 multicast
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return isPrivateIpv4(embeddedV4(b, 12));                      // 64:ff9b::/96 NAT64
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isPrivateIpv4(embeddedV4(b, 2));                       // 2002::/16 6to4
  }
  return false;
}

/** True when `ip` is loopback, private, link-local, multicast or reserved. */
export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // not an IP at all — fail closed
}

// ── URL validation ───────────────────────────────────────────

/**
 * Anything shaped like "<scheme>://…", a protocol-relative "//host/…", or the
 * slash-less "https:host/…" that the WHATWG parser also accepts for a special
 * scheme (`new URL("https:169.254.169.254/x")` really is that host).
 *
 * Deliberately narrower than "does `URL` parse it": a server entry's other
 * fields carry ids like "tv-1396#s1e2" and labels like "Vidcloud: HD", and
 * `URL.canParse` says yes to the latter — "Vidcloud" is a valid scheme. So the
 * slash-less form is recognised only for http/https, where it is the one
 * spelling that reaches a real host.
 */
export function looksLikeUrl(value: string): boolean {
  // The slash-less branch requires a non-space right after the colon, so a
  // label like "http: mirror" — which `new URL` rejects anyway, but would then
  // 400 an otherwise fine playback request — is not mistaken for one.
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^https?:[^\s/]/i.test(value);
}

/**
 * Parses `raw` and rejects anything that isn't an absolute http(s) URL.
 * Synchronous — see `assertPublicUrl` for the address half.
 */
export function parseHttpUrl(raw: unknown): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new BlockedUrlError("Missing URL");
  }

  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BlockedUrlError("Invalid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Unsupported URL scheme "${url.protocol}"`);
  }
  if (!url.hostname) {
    throw new BlockedUrlError("URL has no host");
  }
  return url;
}

// ── Resolution: once, cached, and pinned ─────────────────────

interface ResolvedAddress {
  address: string;
  family: number;
}

interface CacheEntry {
  addresses: ResolvedAddress[];
  expires: number;
}

/**
 * How long a resolved host is reused.
 *
 * This is an optimization, not the security boundary — that is `resolveHost`
 * validating what it resolved. But it is a load-bearing optimization:
 * `/api/cast-proxy` is on the per-segment path for HLS playback, and
 * `dns.lookup` is a blocking `getaddrinfo` on the same four-slot libuv
 * threadpool that serves `fs` and bcrypt. Without this, a handful of viewers
 * pulling four-second HLS segments put a steady stream of blocking resolver
 * calls in front of every login's password hash.
 *
 * Half a minute is what a browser does with its own DNS cache, and short
 * enough that a CDN moving an edge address is picked up within one segment or
 * two.
 */
const HOST_CACHE_TTL_MS = 30_000;

/** Bound on the cache, so a hostile caller can't grow it without limit. */
const HOST_CACHE_MAX = 512;

const hostCache = new Map<string, CacheEntry>();

function cacheKey(hostname: string, family: number): string {
  return `${family}:${hostname.toLowerCase()}`;
}

function readCache(hostname: string, family: number): ResolvedAddress[] | null {
  const key = cacheKey(hostname, family);
  const hit = hostCache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    hostCache.delete(key);
    return null;
  }
  return hit.addresses;
}

function writeCache(
  hostname: string,
  family: number,
  addresses: ResolvedAddress[],
): void {
  if (hostCache.size >= HOST_CACHE_MAX) {
    const now = Date.now();
    for (const [key, entry] of hostCache) {
      if (entry.expires <= now) hostCache.delete(key);
    }
    // Still full of live entries — this is a cache, not a ledger.
    if (hostCache.size >= HOST_CACHE_MAX) hostCache.clear();
  }
  hostCache.set(cacheKey(hostname, family), {
    addresses,
    expires: Date.now() + HOST_CACHE_TTL_MS,
  });
}

/** Drops every cached entry. Tests use it; nothing in the app needs to. */
export function clearHostCache(): void {
  hostCache.clear();
}

/**
 * Resolves a hostname (or passes through an address literal) and rejects it
 * unless *every* address it answers with is publicly routable.
 *
 * Every address, not the first: a name that resolves to one public and one
 * loopback address would otherwise be a coin flip, and the attacker gets to
 * flip it as often as they like.
 *
 * The addresses come back to the caller so the socket can connect to these and
 * only these. Returning a verdict instead — "this hostname is fine" — is what
 * makes a guard rebindable, because the connection then resolves the name
 * again and is free to get a different answer.
 */
async function resolveHost(
  hostname: string,
  family = 0,
): Promise<ResolvedAddress[]> {
  // A bracketed IPv6 literal arrives as "[::1]".
  const host = hostname.replace(/^\[|\]$/g, "");

  const literal = net.isIP(host);
  if (literal) {
    if (!allowPrivateUpstream() && isPrivateAddress(host)) {
      throw new BlockedUrlError(`Refusing to fetch a private address (${host})`);
    }
    return [{ address: host, family: literal }];
  }

  const cached = readCache(host, family);
  if (cached) return cached;

  let addresses: ResolvedAddress[];
  try {
    addresses = (await dns.lookup(host, {
      all: true,
      ...(family ? { family } : {}),
    })) as ResolvedAddress[];
  } catch {
    throw new BlockedUrlError(`Could not resolve host "${host}"`);
  }

  if (!addresses.length) {
    throw new BlockedUrlError(`Host "${host}" resolved to nothing`);
  }

  if (!allowPrivateUpstream()) {
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        // Not cached: a blocked answer is the one thing worth re-checking, and
        // caching it would let a transient poisoned answer stick around.
        throw new BlockedUrlError(
          `Host "${host}" resolves to a private address (${address})`,
        );
      }
    }
  }

  writeCache(host, family, addresses);
  return addresses;
}

/**
 * Resolves the URL's host and rejects it unless every address it answers with
 * is publicly routable.
 *
 * Callers that go on to fetch through `guardedDispatcher` or `guardedAgents`
 * do not strictly need this — the socket is guarded either way — but it turns
 * a refusal into a 400 the route can explain, before any connection is made.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
  await resolveHost(url.hostname);
}

// ── The guarded socket ───────────────────────────────────────

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | ResolvedAddress[],
  family?: number,
) => void;

/**
 * A `lookup` implementation for `net.connect`, and the point where the check
 * and the connection are welded together.
 *
 * Node resolves a hostname through this function and then connects to exactly
 * what it returns, so validating here means there is no second resolution for
 * a rebinding attacker to answer differently — and no redirect hop, however
 * deep, that reaches an address nobody checked.
 *
 * Both callback shapes are supported: `all: true` (what `net` uses when
 * `autoSelectFamily` is on, which it is by default) wants the whole list,
 * everything else wants one address and its family.
 */
export function guardedLookup(
  hostname: string,
  options: unknown,
  callback: LookupCallback,
): void {
  const opts = (options && typeof options === "object" ? options : {}) as {
    all?: boolean;
    family?: number;
  };
  const wantAll = opts.all === true;
  const family = typeof opts.family === "number" ? opts.family : 0;

  resolveHost(hostname, family).then(
    (addresses) => {
      if (wantAll) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    },
    (err) => callback(err as NodeJS.ErrnoException),
  );
}

/**
 * `guardedLookup` never sees an address literal: `net.connect` resolves nothing
 * when `host` is already an IP, so `http://127.0.0.1/` walks straight past a
 * `lookup`-based guard. Literals are therefore checked where the socket is
 * created, which is the one place both spellings meet.
 */
function assertConnectTargetAllowed(host: string): void {
  const bare = host.replace(/^\[|\]$/g, "");
  if (!net.isIP(bare)) return; // a name — guardedLookup handles it
  if (allowPrivateUpstream()) return;
  if (isPrivateAddress(bare)) {
    throw new BlockedUrlError(`Refusing to fetch a private address (${bare})`);
  }
}

type ConnectCallback = (err: Error, stream: Duplex) => void;

/**
 * Agents for every axios client in `core/` that fetches a URL the caller
 * supplied, or a URL scraped out of a page that one led to.
 *
 * These carry the whole guard for axios, which — unlike `safeFetch` — follows
 * redirects itself (up to 21 by default). There is no hook that sees each hop's
 * URL, but every hop has to open a socket, and every socket comes through here.
 *
 * Spread as `...guardedAgents` into the axios config rather than set as an
 * axios *default*: some internal clients legitimately need to reach a
 * private address (another service on the same compose network) and must
 * keep working, so the guard is opt-in per client rather than global.
 *
 * `keepAlive` matches Node's own global agent, so attaching these changes
 * connection reuse for nobody.
 */
class GuardedHttpAgent extends http.Agent {
  override createConnection(
    options: http.ClientRequestArgs,
    callback?: ConnectCallback,
  ): Duplex {
    return guardedConnect(http.Agent.prototype, this, options, callback);
  }
}

class GuardedHttpsAgent extends https.Agent {
  override createConnection(
    options: https.RequestOptions,
    callback?: ConnectCallback,
  ): Duplex {
    return guardedConnect(https.Agent.prototype, this, options, callback);
  }
}

/**
 * Refuses a private target before the socket exists, then hands off to the
 * agent's normal connector.
 *
 * The refusal is reported through the callback on `nextTick` rather than
 * thrown: `Agent.createSocket` treats a synchronous throw as a crash, but an
 * `(err)` callback as a failed connection, which is what this is — and what
 * surfaces to axios as an ordinary request error.
 */
function guardedConnect(
  proto: http.Agent,
  agent: http.Agent,
  options: http.ClientRequestArgs,
  callback?: ConnectCallback,
): Duplex {
  try {
    assertConnectTargetAllowed(String(options?.host ?? ""));
  } catch (err) {
    process.nextTick(() => callback?.(err as Error, undefined as never));
    return undefined as never;
  }
  return proto.createConnection.call(agent, options, callback);
}

export const guardedHttpAgent = new GuardedHttpAgent({
  keepAlive: true,
  lookup: guardedLookup as never,
});

export const guardedHttpsAgent = new GuardedHttpsAgent({
  keepAlive: true,
  lookup: guardedLookup as never,
});

export const guardedAgents = {
  httpAgent: guardedHttpAgent,
  httpsAgent: guardedHttpsAgent,
} as const;

/**
 * The undici equivalent, for `safeFetch`.
 *
 * `fetch` and the dispatcher are imported from the same `undici` package on
 * purpose. Node's built-in `fetch` accepts a `dispatcher`, but it is backed by
 * its *own* bundled copy of undici, and handing one copy's `Agent` to the
 * other copy's fetch works only as long as the internal dispatch contract
 * happens to match across versions. One copy, no such question.
 */
export const guardedDispatcher: Dispatcher = new UndiciAgent({
  connect: { lookup: guardedLookup as never },
});

/** Scheme + address check in one call, from a raw string. Returns the URL. */
export async function assertFetchableUrl(raw: unknown): Promise<URL> {
  const url = parseHttpUrl(raw);
  await assertPublicUrl(url);
  return url;
}

/**
 * The same question as a boolean, for callers that have to answer it inline —
 * `BrowserFetch`'s per-request hook, where a throw would abort the page rather
 * than the one request it is judging.
 */
export async function isFetchableUrl(raw: unknown): Promise<boolean> {
  try {
    await assertFetchableUrl(raw);
    return true;
  } catch {
    return false;
  }
}

// ── Guarded fetch ────────────────────────────────────────────

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetchResult {
  response: Awaited<ReturnType<typeof undiciFetch>>;
  /** The URL that actually served the response, after any redirects. */
  url: URL;
}

/**
 * `fetch`, with every hop validated and every socket pinned to an address the
 * guard resolved itself.
 *
 * Two separate things are going on, and both are needed:
 *
 *   • `guardedDispatcher` means the connection can only ever land on an
 *     address `guardedLookup` resolved and approved. That is what stops DNS
 *     rebinding, and it holds for anything this function reaches.
 *   • Redirects are chased by hand (`redirect: "manual"`) because the built-in
 *     follower would re-enter the network without passing the new URL through
 *     `parseHttpUrl` — the dispatcher would still refuse a private address,
 *     but a redirect to `file:`-adjacent schemes, or simply a hop we never
 *     saw, is worth refusing explicitly. Chasing them here also means the
 *     caller learns which URL actually served the body, which is what a
 *     relative HLS manifest URI has to resolve against.
 */
export async function safeFetch(
  input: string | URL,
  init: UndiciRequestInit = {},
  maxRedirects = MAX_REDIRECTS,
): Promise<SafeFetchResult> {
  let current = parseHttpUrl(input.toString());
  let options: UndiciRequestInit = {
    ...init,
    redirect: "manual",
    dispatcher: guardedDispatcher,
  };

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);

    const response = await undiciFetch(current, options);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, url: current };
    }

    const location = response.headers.get("location");
    if (!location) return { response, url: current };

    // Free the socket — nothing reads a redirect's body. Drained *before* the
    // hop check, not after: bailing out with the body still buffered leaves
    // the connection pinned until GC, so an upstream that redirect-loops is a
    // cheap way to tie one up per request.
    await response.arrayBuffer().catch(() => {});

    if (hop >= maxRedirects) {
      throw new BlockedUrlError("Too many redirects");
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new BlockedUrlError("Invalid redirect target");
    }
    current = parseHttpUrl(next.toString());

    // Same downgrade a browser performs: a 303 (and, by long-standing
    // practice, a 301/302) turns a non-GET into a GET and drops the body.
    const method = (options.method ?? "GET").toUpperCase();
    if (
      (response.status === 303 || response.status === 301 || response.status === 302) &&
      method !== "GET" &&
      method !== "HEAD"
    ) {
      options = { ...options, method: "GET", body: undefined };
    }
  }
}
