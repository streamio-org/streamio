import fs from "node:fs";
import crypto from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { SettingsService } from "../services/settings.service.js";
import { requireAuth, createRequireAdmin } from "../auth/middleware.js";
import { APK_DIR, APK_PATH } from "../services/apk-storage.js";
import { appBaseUrl } from "../version.js";
import type { Database } from "../database/db.js";
import type { IdleShutdownService } from "../services/idle-shutdown.service.js";
import type { UpdateService } from "../services/update.service.js";
import type { WebPlatformHandler } from "../PlatformHandler.js";

export function createSettingsRouter(
  db: Database,
  idleShutdownService: IdleShutdownService,
  updateService: UpdateService,
  platformHandler: WebPlatformHandler,
): Router {
  const router = Router();
  const service = new SettingsService(db);

  // All settings routes are server-wide config — admin only. Admin means an
  // ADMIN_EMAILS address whose *verification* has been completed; see
  // createRequireAdmin.
  router.use(requireAuth, createRequireAdmin(db));

  // ── Hosting points ─────────────────────────────────────────

  router.get("/hosting-points", async (_req: Request, res: Response) => {
    const points = await service.listHostingPoints();
    res.json(points);
  });

  router.post("/hosting-points", async (req: Request, res: Response) => {
    const { name, url, shared_secret } = req.body;
    if (!name || !url) {
      res.status(400).json({ error: "name and url are required." });
      return;
    }
    const point = await service.addHostingPoint(name, url, shared_secret);
    res.status(201).json(point);
  });

  router.put("/hosting-points/:id", async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!;
    const { name, url, shared_secret, enabled } = req.body;
    const point = await service.updateHostingPoint(id, {
      name,
      url,
      sharedSecret: shared_secret,
      enabled,
    });
    if (!point) {
      res.status(404).json({ error: "Hosting point not found." });
      return;
    }
    res.json(point);
  });

  router.delete("/hosting-points/:id", async (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0]! : req.params.id!;
    await service.removeHostingPoint(id);
    res.json({ message: "Hosting point removed." });
  });

  // ── Sync settings ──────────────────────────────────────────

  router.get("/sync", async (_req: Request, res: Response) => {
    const settings = await service.getSyncSettings();
    res.json(settings);
  });

  router.put("/sync", async (req: Request, res: Response) => {
    const { enabled, interval_minutes } = req.body;
    const settings = await service.setSyncSettings({
      enabled,
      intervalMinutes: interval_minutes,
    });
    res.json(settings);
  });

  // ── Power / auto-shutdown ──────────────────────────────────

  router.get("/power", async (_req: Request, res: Response) => {
    const settings = await service.getPowerSettings();
    res.json(settings);
  });

  router.put("/power", async (req: Request, res: Response) => {
    const { enabled, idle_minutes, min_uptime_minutes } = req.body;
    const settings = await service.setPowerSettings({
      enabled,
      idleMinutes: idle_minutes,
      minUptimeMinutes: min_uptime_minutes,
    });
    res.json(settings);
  });

  router.get("/power/status", async (_req: Request, res: Response) => {
    const status = await idleShutdownService.getStatus();
    res.json(status);
  });

  // Requests a shutdown — the app itself can't power off the host (it runs
  // in a container), it only flags the request for the host-side
  // power-controller to pick up and act on.
  router.post("/power/shutdown", async (req: Request, res: Response) => {
    await idleShutdownService.requestManualShutdown(req.user!.email);
    res.json({ message: "Shutdown requested." });
  });

  router.post("/power/shutdown/cancel", async (_req: Request, res: Response) => {
    await idleShutdownService.cancelManualShutdown();
    res.json({ message: "Shutdown request cancelled." });
  });

  // ── Client version policy ──────────────────────────────────
  // What /api/version reports to native clients, and the floor the
  // client-version gate enforces.

  router.get("/client-version", async (_req: Request, res: Response) => {
    res.json(await service.getClientVersionSettings());
  });

  router.put("/client-version", async (req: Request, res: Response) => {
    const { latest, min_supported, download_url, notes, enforce } = req.body ?? {};
    res.json(
      await service.setClientVersionSettings({
        latest,
        minSupported: min_supported,
        downloadUrl: download_url,
        notes,
        enforce,
      }),
    );
  });

  // Uploads the APK itself, so `downloadUrl` can point at this server
  // instead of an admin-pasted external link. Writes to a temp file first
  // and renames into place atomically — a download already in flight when a
  // new upload lands must finish reading the *old* file's bytes, not a mix
  // of old and new (a direct overwrite, especially with Range requests,
  // could tear).
  const apkUpload = multer({
    storage: multer.diskStorage({
      destination: APK_DIR,
      filename: (_req, _file, cb) => cb(null, `.tmp-${crypto.randomUUID()}.apk`),
    }),
    limits: { fileSize: 300 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith(".apk")),
  });

  router.post("/client-version/apk", (req: Request, res: Response, next: NextFunction) => {
    apkUpload.single("apk")(req, res, async (err: unknown) => {
      if (err) {
        const message =
          err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
            ? "File is too large (max 300MB)."
            : "Upload rejected.";
        res.status(400).json({ error: message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded, or it wasn't a .apk file." });
        return;
      }
      try {
        await fs.promises.rename(req.file.path, APK_PATH);
        const current = await service.getClientVersionSettings();
        const updated = await service.setClientVersionSettings({
          downloadUrl: `${appBaseUrl()}/api/version/download`,
          apkUploadedAt: new Date().toISOString(),
          apkVersion: current.latest,
        });
        res.json(updated);
      } catch (renameErr) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        next(renameErr);
      }
    });
  });

  // ── Providers ────────────────────────────────────────────────
  // Per-variant enable/disable + cache management. Disabled state is
  // enforced from Core's in-memory registry (platformHandler), persisted to
  // app_settings for it to survive a restart.

  router.get("/providers", async (_req: Request, res: Response) => {
    res.json(platformHandler.getAdminProviderCatalog());
  });

  router.put("/providers/:slug", async (req: Request, res: Response) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0]! : req.params.slug!;
    if (!platformHandler.getProviderByName(slug)) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }
    const disabled = Boolean(req.body?.disabled);
    await service.setProviderDisabled(slug, disabled, req.user!.email);
    platformHandler.setProviderDisabled(slug, disabled);
    res.json({ slug, disabled });
  });

  router.post("/providers/:slug/clear-cache", async (req: Request, res: Response) => {
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0]! : req.params.slug!;
    if (!platformHandler.getProviderByName(slug)) {
      res.status(404).json({ error: "Unknown provider" });
      return;
    }
    const keysDeleted = await platformHandler.clearProviderCache(slug);
    res.json({ slug, keysDeleted });
  });

  // ── Server self-update ─────────────────────────────────────
  // Policy only — the host-side updater/ process does the actual rebuild.

  router.get("/update", async (_req: Request, res: Response) => {
    res.json(await updateService.getStatus());
  });

  router.put("/update", async (req: Request, res: Response) => {
    const { enabled, auto_apply, repo } = req.body ?? {};
    res.json(await updateService.setSettings({ enabled, autoApply: auto_apply, repo }));
  });

  // Bypasses the release cache — this is the "check now" button.
  router.post("/update/check", async (_req: Request, res: Response) => {
    res.json(await updateService.getStatus(true));
  });

  router.post("/update/apply", async (req: Request, res: Response) => {
    const status = await updateService.requestUpdate(req.user!.email);
    if (!status.updateAvailable) {
      res.status(409).json({
        error: status.enabled
          ? "Already running the latest release."
          : "Updates are not enabled on this server.",
        status,
      });
      return;
    }
    res.json({ message: "Update requested.", status });
  });

  router.post("/update/cancel", async (_req: Request, res: Response) => {
    await updateService.cancelUpdate();
    res.json({ message: "Update request cancelled." });
  });

  router.get("/update/history", async (_req: Request, res: Response) => {
    res.json(await updateService.listHistory());
  });

  return router;
}
