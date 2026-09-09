import { Router } from "express";
import type { Request } from "express";
import { WebPlatformHandler } from "../PlatformHandler.js";
import type { Database } from "../database/db.js";
import type { Redis } from "../database/redis.js";
import { AdultService } from "../services/adult.service.js";

function readProviderFromBody(body: unknown) {
    if (!body || typeof body !== "object") {
        return "";
    }

    const provider = (body as { provider?: unknown }).provider;
    return typeof provider === "string" ? provider.trim() : "";
}

function readProviderFromQuery(query: unknown) {
    if (!query || typeof query !== "object") {
        return "";
    }

    const provider = (query as { provider?: unknown }).provider;
    return typeof provider === "string" ? provider.trim() : "";
}

function isKnownProvider(
    platformHandler: WebPlatformHandler,
    provider: string,
    includeAdult: boolean
) {
    return platformHandler.getListOfProviders(includeAdult).includes(provider);
}

export function createProviderRouter(
    platformHandler: WebPlatformHandler,
    db: Database,
    redis: Redis
) {
    const router = Router();
    const adultService = new AdultService(db, redis);

    // Mounted under optionalAuth: an anonymous caller has no req.user and is
    // refused, which is what keeps 18+ providers off the list by default.
    const isAllowed = (req: Request) => adultService.isAllowed(req.user?.sub);

    // `providers` (bare names) and `catalog` (names + display metadata) are the
    // same list twice. Both are sent because clients predating `catalog` read
    // only the former, and an install is not upgraded in lockstep with the apps
    // pointed at it.
    //
    // `catalog` is one entry per *language variant*, not per source, for the
    // same reason: a client that shipped before provider families existed
    // renders it flat, and grouping it here would have made a language
    // disappear from that client's picker. The grouping data is additive —
    // every entry carries its `family` and that family's full `languages` list,
    // so a newer client groups on `family` and draws a language selector.
    router.get("/", async (req, res, next) => {
        try {
            const includeAdult = await isAllowed(req);

            res.json({
                providers: platformHandler.getListOfProviders(includeAdult),
                catalog: platformHandler.getProviderCatalog(includeAdult),
                // The registry slug, which is what a client sends back as
                // `?provider=` — not `getDefaultProvider().getName()`, which
                // is the provider's own idea of its name.
                default: platformHandler.getDefaultProviderName()
            });
        } catch (err) {
            next(err);
        }
    });

    router.get("/current", async (req, res, next) => {
        try {
            const provider = readProviderFromQuery(req.query);
            const current = isKnownProvider(platformHandler, provider, await isAllowed(req))
                ? provider
                : platformHandler.getDefaultProviderName();

            res.json({
                current
            });
        } catch (err) {
            next(err);
        }
    });

    router.put("/current", async (req, res, next) => {
        try {
            const provider = readProviderFromBody(req.body) || readProviderFromQuery(req.query);

            if (!provider) {
                return res.status(400).json({
                    error: "Missing provider"
                });
            }

            if (!isKnownProvider(platformHandler, provider, await isAllowed(req))) {
                return res.status(400).json({
                    error: `Unknown provider: ${provider}`
                });
            }

            res.status(204).send();
        } catch (err) {
            next(err);
        }
    });

    router.post("/set-provider", async (req, res, next) => {
        try {
            const provider = readProviderFromBody(req.body) || readProviderFromQuery(req.query);

            if (!provider) {
                return res.status(400).json({
                    error: "Missing provider"
                });
            }

            if (!isKnownProvider(platformHandler, provider, await isAllowed(req))) {
                return res.status(400).json({
                    error: `Unknown provider: ${provider}`
                });
            }

            res.json({ success: true, current: provider });
        } catch (err) {
            next(err);
        }
    });

    return router;
}
