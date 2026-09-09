import { Router } from "express";
import { BUILD } from "../version.js";

export function createHealthRouter() {
    const router = Router();

    router.get("/", (_, res) => {
        res.json({
            status: "ok",
            service: "streamio-api",
            // Identifies the exact running build — the fastest way to tell
            // whether a deploy or self-update actually took effect. The
            // client-facing contract lives at /api/version.
            version: BUILD.version,
            commit: BUILD.commit,
            apiVersion: BUILD.apiVersion
        });
    });

    router.get("/short", (_, res) => {
        res.json({
            status: "ok"
        });
    });

    return router;
}