import { Router, type Request, type Response, type NextFunction } from "express";
import type { UpdateService } from "../services/update.service.js";

// Host-facing endpoints polled by the external updater (see updater/),
// authenticated with a shared secret rather than user auth — same shape as
// power.router.ts, and for the same reason: no logged-in user is involved,
// and the caller lives outside Docker because it has to rebuild and restart
// the very container this code runs in.
export function createUpdateRouter(updateService: UpdateService): Router {
  const router = Router();

  const requireUpdateSecret = (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.UPDATE_CONTROLLER_SECRET;
    if (!expected) {
      res.status(503).json({ error: "Updater not configured on this server." });
      return;
    }
    if (req.header("X-Update-Secret") !== expected) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Missing or invalid X-Update-Secret header.",
      });
      return;
    }
    next();
  };

  router.get("/status", requireUpdateSecret, async (_req: Request, res: Response) => {
    res.json(await updateService.getStatus());
  });

  // Called right before the updater rebuilds — i.e. before this process is
  // killed. It both records the attempt and clears the pending flag, so the
  // update can't be picked up a second time by the container that replaces
  // this one.
  router.post("/start", requireUpdateSecret, async (req: Request, res: Response) => {
    const { to_version, trigger, requested_by } = req.body ?? {};
    if (!to_version || (trigger !== "manual" && trigger !== "auto")) {
      res.status(400).json({ error: "to_version and trigger ('manual'|'auto') are required." });
      return;
    }
    const id = await updateService.recordUpdateStarted(
      String(to_version),
      trigger,
      requested_by ? String(requested_by) : null,
    );
    res.json({ id });
  });

  // Reported once the new stack is healthy (or once the updater gives up).
  // On success this lands on the *new* container, hence the explicit id.
  router.post("/finish", requireUpdateSecret, async (req: Request, res: Response) => {
    const { id, status, error } = req.body ?? {};
    if (!id || (status !== "ok" && status !== "error")) {
      res.status(400).json({ error: "id and status ('ok'|'error') are required." });
      return;
    }
    await updateService.recordUpdateFinished(String(id), status, error ? String(error) : null);
    res.json({ message: "Recorded." });
  });

  return router;
}
