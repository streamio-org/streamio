import { Router } from "express";
import type { Request } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebPlatformHandler } from "../PlatformHandler.js";
import { UnknownProviderError } from "../core/core.js";
import {
    BlockedUrlError,
    assertFetchableUrl,
    looksLikeUrl,
    parseHttpUrl,
    safeFetch,
} from "../core/utils/ssrf.js";
import type { Database } from "../database/db.js";
import type { Redis } from "../database/redis.js";
import { AdultService } from "../services/adult.service.js";
import { IntroDbService, type IntroLookupParams } from "../services/intro-db.service.js";
import {
    filterCategories,
    filterItems,
    isAdultItem,
} from "../services/adult-filter.service.js";

// Public base the Chromecast reaches us on. Child segment/variant URLs in a
// rewritten HLS manifest MUST use this exact base — the same base the
// browser sender uses (fetched via GET /api/cast-config) — or the master
// manifest loads while every segment 404s. Configurable via APP_URL.
const CAST_PUBLIC_BASE = (
    process.env.APP_URL || "http://localhost:3003"
).replace(/\/+$/, "");
const CAST_PROXY_PREFIX = `${CAST_PUBLIC_BASE}/api/cast-proxy?url=`;

// Custom CAF receiver app id registered in the Google Cast console (see
// README "Chromecast" section for how to register your own).
const CAST_RECEIVER_APP_ID = process.env.CAST_RECEIVER_APP_ID || "BF64D6B2";

// Rewrite an HLS manifest so every referenced URI (variant playlists, media
// segments, AES keys, #EXT-X-MEDIA / #EXT-X-KEY URIs, ...) is routed back
// through this proxy. `proxyPrefix` is absolute (CAST_PROXY_PREFIX) for the
// Chromecast receiver, which has no page origin to resolve a relative URL
// against; direct in-browser playback uses a root-relative prefix instead so
// it keeps working under whatever host/tunnel is currently serving the page.
function rewriteHlsManifest(text: string, source: URL, proxyPrefix: string): string {
    const origin = source.origin;
    // Base directory for resolving relative URIs (path only — ignore the query).
    const dir = origin + source.pathname.replace(/[^/]*$/, "");

    const toAbsolute = (uri: string): string => {
        if (/^https?:\/\//i.test(uri)) return uri;
        if (uri.startsWith("/")) return origin + uri;
        return dir + uri;
    };
    const toProxy = (uri: string): string =>
        proxyPrefix + encodeURIComponent(toAbsolute(uri));

    return text
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;

            if (trimmed.startsWith("#")) {
                // Tag lines only need rewriting when they carry a URI="..."
                // (e.g. #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF).
                if (trimmed.includes('URI="')) {
                    return trimmed.replace(
                        /URI="([^"]+)"/g,
                        (_m, uri) => `URI="${toProxy(uri)}"`
                    );
                }
                return line;
            }

            // Bare line → a segment or variant playlist URL.
            return toProxy(trimmed);
        })
        .join("\n");
}

function readPage(value: unknown) {
    if (typeof value !== "string") {
        return 1;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function readContentType(value: unknown) {
    return value === "movie" ? "movie" : "episode";
}

function readProviderFromQuery(query: unknown) {
    if (!query || typeof query !== "object") {
        return "";
    }

    const provider = (query as { provider?: unknown }).provider;
    return typeof provider === "string" ? provider.trim() : "";
}

function readServerFromBody(body: unknown) {
    if (!body || typeof body !== "object") {
        return null;
    }

    const server = (body as { server?: unknown }).server;
    return server && typeof server === "object" ? server : null;
}

/** No legitimate server entry carries more than a couple of URLs. */
const MAX_SERVER_URLS = 10;

/**
 * How many values the walk will look at before giving up.
 *
 * There is deliberately no *depth* limit. A cap of three levels was enough for
 * today's `VideoServer` (a flat `{id, name, src}`), but the whole point of
 * checking here rather than in each provider is that a source added later
 * inherits the check without knowing about it — and a nested `headers` or
 * `options` bag is exactly the shape such a source would arrive in. A URL that
 * sits one level too deep to be seen is a hole that opens silently.
 *
 * A node budget bounds the walk just as well and doesn't care about shape.
 * Express's own body-size limit already bounds what can get this far; this is
 * belt-and-braces against a pathological object.
 */
const MAX_SERVER_NODES = 2_000;

interface WalkState {
    found: string[];
    nodes: number;
}

function collectUrls(value: unknown, state: WalkState): string[] {
    if (state.nodes++ > MAX_SERVER_NODES) return state.found;
    if (state.found.length > MAX_SERVER_URLS) return state.found;

    if (typeof value === "string") {
        const text = value.trim();
        if (looksLikeUrl(text)) {
            state.found.push(text.startsWith("//") ? `https:${text}` : text);
        }
        return state.found;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectUrls(item, state);
        return state.found;
    }
    if (value && typeof value === "object") {
        for (const item of Object.values(value)) collectUrls(item, state);
    }
    return state.found;
}

/**
 * The `server` object POSTed to `/episodes/:id/video` is whatever the client
 * says it is, and every provider's `getVideo` fetches the URL inside it — so
 * without this the endpoint resolves *any* address the container can reach and
 * reports back what it found. Checked here, at the one route that accepts the
 * object, rather than in each provider: a new source would otherwise inherit
 * the hole by simply not knowing about it.
 *
 * It is the outermost of three layers, and the only one that can answer with a
 * clean 400 before anything is attempted. `Core.resolveVideo` repeats it for
 * callers that bypass this router (the provider tests do), and underneath both,
 * the axios clients and `safeFetch` connect only to addresses the guard
 * resolved itself — which is what covers the redirect hops nobody here can see.
 */
async function assertServerFetchable(server: object): Promise<void> {
    const urls = collectUrls(server, { found: [], nodes: 0 });
    if (urls.length > MAX_SERVER_URLS) {
        throw new BlockedUrlError("Server entry carries too many URLs");
    }
    await Promise.all(urls.map((url) => assertFetchableUrl(url)));
}

function readIntroDbParams(query: unknown): IntroLookupParams | null {
    if (!query || typeof query !== "object") return null;
    const q = query as Record<string, unknown>;

    const type = q.type === "movie" ? "movie" : q.type === "tv" ? "tv" : null;
    if (!type) return null;

    const tmdbIdNum = q.tmdbId ? Number(q.tmdbId) : NaN;
    const tmdbId = Number.isFinite(tmdbIdNum) && tmdbIdNum > 0 ? tmdbIdNum : undefined;
    const imdbId = typeof q.imdbId === "string" && q.imdbId.trim() ? q.imdbId.trim() : undefined;

    if (!tmdbId && !imdbId) return null;

    const durationMsNum = q.durationMs ? Number(q.durationMs) : NaN;
    const durationMs = Number.isFinite(durationMsNum) && durationMsNum > 0 ? durationMsNum : undefined;

    if (type === "tv") {
        const season = Number(q.season);
        const episode = Number(q.episode);
        if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
        return { type, tmdbId, imdbId, season, episode, durationMs };
    }

    return { type, tmdbId, imdbId, durationMs };
}

export function createContentRouter(
    platformHandler: WebPlatformHandler,
    db: Database,
    redis: Redis
) {
    const router = Router();
    const adultService = new AdultService(db, redis);
    const introDb = new IntroDbService(redis);

    const ADULT_DISABLED = { error: "Adult content disabled" };

    /**
     * The provider Core will actually dispatch to.
     *
     * No `?provider=` at all — what the home page sends until a source is
     * picked — is the server's own default.
     *
     * A name that is present but unrecognised is rejected, not defaulted. Both
     * clients validate their stored provider against `GET /api/providers` and
     * drop one the server no longer offers, so the only thing a fallback would
     * buy is silence: an app sending a provider's *display* name instead of its
     * slug would get the default catalogue back under the name it asked for,
     * and read it as "this source has nothing".
     */
    function resolveProviderName(requested: string) {
        if (!requested) return platformHandler.getDefaultProviderName();
        if (!platformHandler.getProviderByName(requested)) {
            throw new UnknownProviderError(requested);
        }
        return requested;
    }

    /** Resolves the 18+ gate for one request, once. */
    async function gate(req: Request) {
        const provider = resolveProviderName(readProviderFromQuery(req.query));
        const allowed = await adultService.isAllowed(req.user?.sub);

        return {
            provider,
            allowed,
            denylist: async () => new Set<string>(),
        };
    }

    router.get("/home", async (req, res, next) => {
        try {
            const { provider, allowed, denylist } = await gate(req);

            const data = await platformHandler.getHome(provider);

            res.json({
                data: allowed
                    ? data
                    : filterCategories(data as any[], await denylist()),
            });
        } catch (err) {
            next(err);
        }
    });

    router.get("/search", async (req, res, next) => {
        try {
            const query = typeof req.query.query === "string" ? req.query.query.trim() : "";

            if (!query) {
                return res.status(400).json({
                    error: "Missing query"
                });
            }

            const { provider, allowed, denylist } = await gate(req);

            const page = readPage(req.query.page);
            const data = await platformHandler.search(provider, query, page);

            let items = data as any[];
            if (!allowed) items = filterItems(items, await denylist());

            res.json({ query, page, data: items });
        } catch (err) {
            next(err);
        }
    });

    router.get("/genres", async (req, res, next) => {
        try {
            const { provider } = await gate(req);

            // Not every provider's upstream site has a genre filter. That's an
            // empty catalogue the client can hide the genre UI on, not an
            // error — the search page asks for this on every provider.
            if (!platformHandler.supportsGenres(provider)) {
                return res.json({ provider, supported: false, data: [] });
            }

            const data = await platformHandler.getGenres(provider);

            res.json({
                provider,
                supported: true,
                data,
            });
        } catch (err) {
            next(err);
        }
    });

    // Browse the titles inside one genre. Paged the same way search is, so the
    // client can keep loading more from a single genre.
    router.get("/genres/:genreId", async (req, res, next) => {
        try {
            const { provider, allowed, denylist } = await gate(req);

            if (!platformHandler.supportsGenres(provider)) {
                return res.status(400).json({
                    error: `Provider "${provider}" does not support genre browsing`,
                });
            }

            const { genreId } = req.params;
            const page = readPage(req.query.page);
            const genre = (await platformHandler.getGenre(provider, genreId, page)) as any;

            const shows = Array.isArray(genre?.shows) ? genre.shows : [];

            res.json({
                provider,
                page,
                data: {
                    ...genre,
                    shows: allowed ? shows : filterItems(shows, await denylist()),
                },
            });
        } catch (err) {
            next(err);
        }
    });

    router.get("/shows/:showId", async (req, res, next) => {
        try {
            const { provider, allowed, denylist } = await gate(req);

            const { showId } = req.params;
            const data = await platformHandler.getShowDetails(provider, showId);

            if (!allowed && isAdultItem(data, await denylist())) {
                return res.status(403).json(ADULT_DISABLED);
            }

            res.json({ data });
        } catch (err) {
            next(err);
        }
    });

    router.get("/seasons/:seasonId/episodes", async (req, res, next) => {
        try {
            const { provider } = await gate(req);

            const { seasonId } = req.params;
            const data = await platformHandler.getEpisodes(provider, seasonId);
            res.json({ data });
        } catch (err) {
            next(err);
        }
    });

    router.get("/episodes/:episodeId/servers", async (req, res, next) => {
        try {
            const { provider } = await gate(req);

            const { episodeId } = req.params;
            const contentType = readContentType(req.query.contentType);
            const data = await platformHandler.getServers(provider, episodeId, contentType);

            res.json({
                data
            });
        } catch (err) {
            next(err);
        }
    });

    // Pure third-party metadata lookup — never dispatches through Core, so no
    // gate()/adult-content check applies. `provider`/`showId` in the query are
    // only a cache-key namespace for the title-match memoization inside
    // IntroDbService, not a provider dispatch target.
    router.get("/intro-segments", async (req, res, next) => {
        try {
            const params = readIntroDbParams(req.query);
            if (!params) {
                return res.status(400).json({ error: "Missing or invalid id/title params" });
            }

            const data = await introDb.lookup(params);
            res.json({ data });
        } catch (err) {
            next(err);
        }
    });

    router.post("/episodes/:episodeId/video", async (req, res, next) => {
        try {
            const server = readServerFromBody(req.body);

            if (!server) {
                return res.status(400).json({
                    error: "Missing server"
                });
            }

            const { provider } = await gate(req);

            try {
                await assertServerFetchable(server);
            } catch (err) {
                if (err instanceof BlockedUrlError) {
                    // Deliberately vague: the reason names what the host
                    // resolved to, which is exactly the answer the request was
                    // fishing for.
                    return res.status(400).json({ error: "Unsupported server URL" });
                }
                throw err;
            }

            // `fresh=1` bypasses the cached resolve — the client sends it
            // after a playback failure, so a retry doesn't just hand back
            // the same broken cached URL for the rest of the TTL window.
            const fresh = req.query.fresh === "1";
            const data = await platformHandler.resolveVideo(provider, server, fresh);

            res.json({
                data
            });
        } catch (err) {
            next(err);
        }
    });

    router.get("/cast-proxy", async (req, res, next) => {
        const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
        if (!rawUrl) return res.status(400).send("Missing url");

        // This endpoint fetches an arbitrary caller-supplied URL and relays the
        // body back, so it is only a stream proxy and not a request-forgery
        // proxy because of this check: http(s) only, and no address the
        // container can reach but the internet cannot (cloud metadata,
        // localhost, the compose network). `safeFetch` below re-checks after
        // every redirect — a permitted host that 302s to 169.254.169.254 would
        // otherwise sail past this one.
        let target: URL;
        try {
            target = parseHttpUrl(rawUrl);
        } catch {
            return res.status(400).send("Invalid url");
        }

        // Direct (non-cast) playback has no fixed public domain — the same
        // install is reachable through any tunnel/host — so child URIs are
        // rewritten *relative to this manifest's own URL* and resolve against
        // whatever origin and path actually served it. The Chromecast receiver
        // has no page origin to resolve against, so it keeps the fixed
        // absolute base instead.
        //
        // Relative, NOT root-relative ("/api/cast-proxy?..."): on a
        // path-prefixed install (APP_URL = https://host/streamio) a leading
        // slash drops the prefix, so every child resolves to
        // https://host/api/cast-proxy?... and 404s while the master manifest
        // loads fine. This manifest is always served from ".../api/cast-proxy",
        // so a bare "cast-proxy?..." re-resolves correctly under both
        // "https://host/streamio/api/" and a bare "https://tunnel/api/".
        //
        // The "direct=1" flag must be threaded through so a multi-level
        // manifest (master → variant playlist → segments) keeps resolving
        // this way at every level, not just the first.
        // Some CDNs check the Referer against the *player* host and refuse the
        // default below (their own origin). The resolver already knows the
        // right value and puts it in the payload's `headers`, so the client
        // can pass it here; it is threaded into the child prefix for the same
        // reason `direct` is, or a master manifest would load and every
        // segment 403.
        const refOverride =
            typeof req.query.ref === "string" && /^https?:\/\//i.test(req.query.ref)
                ? req.query.ref
                : "";

        const refParam = refOverride
            ? `ref=${encodeURIComponent(refOverride)}&`
            : "";

        const childProxyPrefix =
            req.query.direct === "1"
                ? `cast-proxy?direct=1&${refParam}url=`
                : `${CAST_PUBLIC_BASE}/api/cast-proxy?${refParam}url=`;

        // Bound how long a hung upstream connection can block a segment —
        // without this, a stalled CDN connection starves the player
        // indefinitely instead of surfacing as a fetch error hls.js can
        // retry from.
        //
        // This bounds time-to-FIRST-BYTE only, and the distinction is
        // load-bearing: the timer used to cover the whole exchange, body
        // included, so a large fragment arriving over a slow tunnel was
        // aborted mid-download at 20s even though it was transferring fine.
        // It is cleared the moment response headers arrive; from there the
        // client's own disconnect (below) is what ends a stream nobody is
        // waiting for any more.
        //
        // Kept just under the client's TTFB budget (see `fragLoadPolicy` in
        // public/scripts/watch.js) so a dead upstream surfaces as an explicit
        // 504 hls.js can retry from, rather than as a client-side timeout.
        const upstreamController = new AbortController();
        const upstreamTimeout = setTimeout(
            () => upstreamController.abort(),
            25_000
        );
        res.on("close", () => upstreamController.abort());

        try {
            // Forward Range so the Chromecast can seek inside media segments.
            const range = req.headers.range;
            const { response: upstream, url: servedFrom } = await safeFetch(target, {
                signal: upstreamController.signal,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Referer": refOverride || target.origin + "/",
                    ...(refOverride
                        ? { Origin: new URL(refOverride).origin }
                        : {}),
                    // Some CDNs 403 anything that doesn't look like a
                    // cross-origin XHR from a player page, and want all three
                    // of these — any two still fail. A real browser always
                    // sends them, so their *absence* is the anomaly and no
                    // upstream can be broken by having them.
                    "sec-fetch-dest": "empty",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-site": "cross-site",
                    ...(range ? { Range: range } : {}),
                },
            });
            // Headers are in — the body is now allowed to take as long as it
            // takes. Everything below is already guarded by the res "close"
            // abort above.
            clearTimeout(upstreamTimeout);

            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Headers", "*");

            // 206 Partial Content is a success for ranged segment requests.
            if (!upstream.ok && upstream.status !== 206) {
                return res.status(upstream.status).send("Upstream error");
            }

            // Relative URIs inside a manifest resolve against the URL that
            // actually *served* it, not the one we asked for — the two differ
            // whenever the upstream redirects. Pluto TV's playlist entries are
            // jmp2.uk redirectors into pluto.tv's stitcher, and resolving its
            // relative children ("1539795/playlist.m3u8?…") against the
            // redirector gives https://jmp2.uk/1539795/… — a master manifest
            // that loads perfectly and every child 404ing.
            // `servedFrom` is the last hop safeFetch actually fetched — with
            // redirects chased by hand, `upstream.url` is only ever the URL of
            // the request that produced this response's *headers*, so it can't
            // stand in here.
            const base = servedFrom;

            const contentType = upstream.headers.get("content-type") ?? "";
            const isManifest =
                contentType.includes("mpegurl") ||
                base.pathname.endsWith(".m3u8") ||
                target.pathname.endsWith(".m3u8") ||
                base.search.includes("type=audio") ||      // e.g. an audio-only rendition playlist
                base.search.includes("type=video") ||      // e.g. a video-only rendition playlist
                base.search.includes("type=subtitle");     // e.g. a subtitle rendition playlist

            if (isManifest) {
                res.set("Content-Type", "application/vnd.apple.mpegurl");
                const text = await upstream.text();
                return res.send(rewriteHlsManifest(text, base, childProxyPrefix));
            }

            // Binary passthrough (media segments, AES keys, VTT, ...). Mirror
            // the upstream status and range-related headers so seeking works.
            for (const header of [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
            ]) {
                const value = upstream.headers.get(header);
                if (value) res.set(header, value);
            }
            // Sideloaded subtitle tracks: CAF refuses a text track that isn't
            // served as text/vtt, and upstreams routinely send octet-stream (or
            // nothing at all) for .vtt files.
            const upstreamType = upstream.headers.get("content-type") ?? "";
            if (
                target.pathname.toLowerCase().endsWith(".vtt") &&
                (!upstreamType || upstreamType.includes("octet-stream"))
            ) {
                res.set("Content-Type", "text/vtt; charset=utf-8");
            } else if (!upstreamType) {
                res.set("Content-Type", "application/octet-stream");
            }

            res.status(upstream.status);

            // Stream segments/keys/subtitles through as they arrive instead
            // of buffering the whole body in memory first — buffering here
            // added a full upstream-download's worth of latency to every
            // fragment, which is enough to starve hls.js's buffer under
            // normal playback (it never gets ahead of real-time).
            if (!upstream.body) {
                return res.end();
            }
            await pipeline(
                Readable.fromWeb(upstream.body as any),
                res
            );
        } catch (err) {
            clearTimeout(upstreamTimeout);
            if ((err as any)?.name === "AbortError") {
                if (!res.headersSent) res.status(504).send("Upstream timeout");
                return;
            }
            // A redirect into a private address, or a URL that was fine on the
            // way in and resolved somewhere it shouldn't. Never a 5xx: nothing
            // is wrong with this server.
            if (err instanceof BlockedUrlError) {
                if (!res.headersSent) res.status(400).send("Blocked url");
                return;
            }
            // Client aborted mid-segment (seek, tab close, hls.js retry) —
            // pipeline() throws once the response is already committed, so
            // there's no JSON error we could send even if we wanted to.
            if ((err as any)?.code === "ERR_STREAM_PREMATURE_CLOSE" || res.headersSent) {
                return;
            }
            next(err);
        }
    });

    router.get("/cast-config", (req, res) => {
        res.json({
            castProxyBase: CAST_PROXY_PREFIX,
            castReceiverAppId: CAST_RECEIVER_APP_ID
        });
    });

    router.get("/cast-log", (req, res) => {
        res.set({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
        });

        const { ts, msg } = req.query ?? {};

        console.log("[CAST-RECEIVER]", {
            ts,
            msg: typeof msg === "string" ? decodeURIComponent(msg) : ""
        });

        res.sendStatus(204);
    });
    
    return router;
}