import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { Router } from "express";
import path from "node:path";

type PublicPage =
    | "home"
    | "catalog"
    | "search"
    | "providers"
    | "details"
    | "watch"
    | "rooms"
    | "account"
    | "adminProviders"
    | "adminLocalProvider"
    | "login"
    | "tv"
    | "verifyEmail"
    | "resetPassword";

const pageFiles: Record<PublicPage, string> = {
    home: "home.html",
    catalog: "catalog.html",
    search: "search.html",
    providers: "providers.html",
    details: "details.html",
    watch: "watch.html",
    rooms: "rooms.html",
    account: "account.html",
    adminProviders: "admin-providers.html",
    adminLocalProvider: "admin-local-provider.html",
    login: "login.html",
    tv:    "tv.html",
    verifyEmail:   "verify-email.html",
    resetPassword: "reset-password.html"
};

function resolvePublicDir() {
    return path.resolve(process.cwd(), "public");
}

export function createPublicRouter() {
    const router = Router();
    const publicDir = resolvePublicDir();

    router.get("/", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.home));
    });

    router.get("/home", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.home));
    });

    router.get("/catalog", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.catalog));
    });

    router.get("/search", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.search));
    });

    router.get("/providers", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.providers));
    });

    router.get("/details", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.details));
    });

    router.get("/watch", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.watch));
    });

    router.get("/rooms", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.rooms));
    });

    router.get("/account", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.account));
    });

    router.get("/admin/providers", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.adminProviders));
    });

    router.get("/admin/local-provider", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.adminLocalProvider));
    });

    router.get("/login", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.login));
    });

    // Where a television sends its user: short enough to read off a screen and
    // type on a phone. The page itself requires a session (see scripts/tv.js).
    router.get("/tv", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.tv));
    });

    router.get("/auth/callback", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.login)); 
    });

    router.get("/verify-email", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.verifyEmail));
    });

    router.get("/reset-password", (_, res) => {
        res.sendFile(path.join(publicDir, pageFiles.resetPassword));
    });

    return router;
}