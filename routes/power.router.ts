import { Router, type Request, type Response, type NextFunction } from "express";
import type { IdleShutdownService } from "../services/idle-shutdown.service.js";

// Host-facing endpoint polled by the external power-controller (see
// power-controller/), authenticated with a shared secret — not the JWT user
// auth used elsewhere, since nothing here represents a logged-in user.
export function createPowerRouter(idleShutdownService: IdleShutdownService): Router {
  const router = Router();

  const requirePowerSecret = (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.POWER_CONTROLLER_SECRET;
    if (!expected) {
      res.status(503).json({ error: "Power controller not configured on this server." });
      return;
    }
    const secret = req.header("X-Power-Secret");
    if (secret !== expected) {
      res.status(401).json({ error: "Unauthorized", message: "Missing or invalid X-Power-Secret header." });
      return;
    }
    next();
  };

  router.get("/status", requirePowerSecret, async (_req: Request, res: Response) => {
    const status = await idleShutdownService.getStatus();
    res.json(status);
  });

  // Called by power-controller right before it actually powers the host off,
  // so a manual request doesn't outlive the reboot it caused (Redis persists
  // to disk, so without this the flag would still be set — and re-trigger a
  // shutdown — the moment the box comes back up via WOL).
  router.post("/ack-shutdown", requirePowerSecret, async (_req: Request, res: Response) => {
    await idleShutdownService.cancelManualShutdown();
    res.json({ message: "Acknowledged." });
  });

  return router;
}
