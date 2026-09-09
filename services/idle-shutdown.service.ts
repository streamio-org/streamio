// idle-shutdown.service.ts
//
// Tracks whether the server looks idle and exposes that as a simple
// { shouldShutdown, reason } status. This service only decides policy — it
// never touches the host's power state itself (the app runs inside a Docker
// container and has no way to power off the physical machine). A separate,
// host-side process (see power-controller/) polls the status endpoint this
// service backs and runs the actual poweroff command.
import type { Redis } from "../database/redis.js";
import type { SettingsService } from "./settings.service.js";

const LAST_ACTIVITY_KEY = "power:last_activity";
const MANUAL_SHUTDOWN_KEY = "power:manual_shutdown";
// Self-clears if the host watcher is slow/down for a while, so a manual
// request never latches forever and fires on some unrelated future boot.
const MANUAL_SHUTDOWN_TTL_SECONDS = 600;

export interface PowerStatus {
  shouldShutdown: boolean;
  reason: "manual" | "idle" | null;
  enabled: boolean;
  idleMinutes: number;
  minUptimeMinutes: number;
  idleSeconds: number;
  uptimeSeconds: number;
}

export class IdleShutdownService {
  // In-memory, reset every time the process starts — deliberately not
  // persisted. Redis' last-activity value survives a Docker/host restart
  // (redis has its own volume), so without this floor a WOL-woken box with
  // stale "idle for hours" state would shut itself right back off before
  // anyone gets a chance to use it.
  private readonly bootTimeMs = Date.now();

  constructor(
    private readonly redis: Redis,
    private readonly settingsService: SettingsService
  ) {}

  async recordActivity(): Promise<void> {
    await this.redis.set(LAST_ACTIVITY_KEY, Date.now());
  }

  async requestManualShutdown(requestedBy: string): Promise<void> {
    await this.redis.set(
      MANUAL_SHUTDOWN_KEY,
      { requestedAt: Date.now(), requestedBy },
      MANUAL_SHUTDOWN_TTL_SECONDS
    );
  }

  async cancelManualShutdown(): Promise<void> {
    await this.redis.del(MANUAL_SHUTDOWN_KEY);
  }

  async getStatus(): Promise<PowerStatus> {
    const settings = await this.settingsService.getPowerSettings();
    const now = Date.now();

    const lastActivityMs = (await this.redis.get<number>(LAST_ACTIVITY_KEY)) ?? this.bootTimeMs;
    const idleSeconds = Math.max(0, Math.floor((now - lastActivityMs) / 1000));
    const uptimeSeconds = Math.max(0, Math.floor((now - this.bootTimeMs) / 1000));

    const manual = await this.redis.get<{ requestedAt: number; requestedBy: string }>(
      MANUAL_SHUTDOWN_KEY
    );

    let shouldShutdown = false;
    let reason: PowerStatus["reason"] = null;

    if (manual) {
      shouldShutdown = true;
      reason = "manual";
    } else if (
      settings.enabled &&
      uptimeSeconds >= settings.minUptimeMinutes * 60 &&
      idleSeconds >= settings.idleMinutes * 60
    ) {
      shouldShutdown = true;
      reason = "idle";
    }

    return {
      shouldShutdown,
      reason,
      enabled: settings.enabled,
      idleMinutes: settings.idleMinutes,
      minUptimeMinutes: settings.minUptimeMinutes,
      idleSeconds,
      uptimeSeconds,
    };
  }
}
