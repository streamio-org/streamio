// update.service.ts
//
// Decides whether this install is behind the latest published release, and
// flags updates for the host-side updater/ process to carry out. Same split
// as idle-shutdown.service.ts / power-controller: the app runs inside a
// container and cannot rebuild or restart the stack it is part of, so all it
// does here is policy — check, decide, record. updater/ polls
// /internal/update/status and does the actual `git fetch` + `docker compose
// up -d --build`.
import type { Database } from "../database/db.js";
import type { Redis } from "../database/redis.js";
import type { SettingsService } from "./settings.service.js";
import { BUILD, compareSemver } from "../version.js";

const LATEST_RELEASE_KEY = "update:latest_release";
const MANUAL_UPDATE_KEY = "update:manual";
// Long enough that a poll loop doesn't hammer GitHub's rate limit, short
// enough that a fresh release is picked up within the hour.
const RELEASE_CACHE_TTL_SECONDS = 1_800;
// Mirrors the power flow: a manual request that the updater never picks up
// (host watcher down) expires instead of latching forever.
const MANUAL_UPDATE_TTL_SECONDS = 1_800;

export interface ReleaseInfo {
  version: string;      // tag, normalized without a leading "v"
  ref: string;          // the exact git ref to check out, as published
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
}

export interface UpdateStatus {
  /** true when the updater should act now */
  shouldUpdate: boolean;
  reason: "manual" | "auto" | null;
  requestedBy: string | null;
  updateAvailable: boolean;
  currentVersion: string;
  currentCommit: string;
  latest: ReleaseInfo | null;
  enabled: boolean;
  autoApply: boolean;
  repo: string | null;
  lastCheckedAt: string | null;
  lastCheckError: string | null;
}

export interface UpdateSettings {
  enabled: boolean;
  autoApply: boolean;
  repo: string | null;
}

const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  enabled: false,
  // Off by default: an unattended rebuild is a big hammer, so the admin has
  // to opt in. With it off, updates are still detected and surfaced — they
  // just wait for an explicit "apply".
  autoApply: false,
  repo: null,
};

export class UpdateService {
  private lastCheckedAt: string | null = null;
  private lastCheckError: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly settingsService: SettingsService,
  ) {}

  // ── Settings ───────────────────────────────────────────────

  async getSettings(): Promise<UpdateSettings> {
    const row = await this.db.one<{ value: any }>(
      `SELECT value FROM app_settings WHERE key = 'update'`,
    );
    const stored = { ...DEFAULT_UPDATE_SETTINGS, ...(row?.value ?? {}) };
    // Env wins as a default only — an explicitly stored repo overrides it.
    if (!stored.repo) stored.repo = process.env.UPDATE_REPO?.trim() || null;
    return stored;
  }

  async setSettings(updates: Partial<UpdateSettings>): Promise<UpdateSettings> {
    const current = await this.getSettings();
    const next: UpdateSettings = { ...current };
    if (updates.enabled !== undefined) next.enabled = updates.enabled;
    if (updates.autoApply !== undefined) next.autoApply = updates.autoApply;
    if (updates.repo !== undefined) next.repo = updates.repo?.trim() || null;

    await this.db.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('update', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    // Repo change invalidates whatever release we had cached.
    if (updates.repo !== undefined) await this.redis.del(LATEST_RELEASE_KEY);
    return next;
  }

  // ── Release lookup ─────────────────────────────────────────

  /**
   * Latest published release for the configured repo. Cached in Redis; pass
   * `force` (admin "check now") to bypass the cache.
   */
  async getLatestRelease(force = false): Promise<ReleaseInfo | null> {
    if (!force) {
      const cached = await this.redis.get<ReleaseInfo>(LATEST_RELEASE_KEY);
      if (cached) return cached;
    }

    const { repo } = await this.getSettings();
    if (!repo) return null;

    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "streamio-updater",
      };
      // Optional — only needed for private repos or to lift the rate limit.
      const token = process.env.UPDATE_GITHUB_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;

      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        throw new Error(`GitHub returned ${res.status}`);
      }
      const body: any = await res.json();
      const release: ReleaseInfo = {
        version: String(body.tag_name ?? "").replace(/^v/, ""),
        ref: String(body.tag_name ?? ""),
        url: body.html_url ?? null,
        notes: body.body ?? null,
        publishedAt: body.published_at ?? null,
      };
      if (!release.version) throw new Error("Release has no tag_name");

      await this.redis.set(LATEST_RELEASE_KEY, release, RELEASE_CACHE_TTL_SECONDS);
      this.lastCheckedAt = new Date().toISOString();
      this.lastCheckError = null;
      return release;
    } catch (err) {
      this.lastCheckedAt = new Date().toISOString();
      this.lastCheckError = err instanceof Error ? err.message : String(err);
      console.error(`[update] release check failed: ${this.lastCheckError}`);
      // Fall back to whatever we last knew, so a GitHub outage doesn't make
      // a pending update disappear from the UI.
      return this.redis.get<ReleaseInfo>(LATEST_RELEASE_KEY);
    }
  }

  // ── Status ─────────────────────────────────────────────────

  async getStatus(force = false): Promise<UpdateStatus> {
    const settings = await this.getSettings();
    const latest = settings.enabled ? await this.getLatestRelease(force) : null;

    const updateAvailable =
      latest !== null && compareSemver(latest.version, BUILD.version) > 0;

    const manual = await this.redis.get<{ requestedBy: string; targetVersion: string }>(
      MANUAL_UPDATE_KEY,
    );

    let shouldUpdate = false;
    let reason: UpdateStatus["reason"] = null;
    let requestedBy: string | null = null;

    if (manual && updateAvailable) {
      shouldUpdate = true;
      reason = "manual";
      requestedBy = manual.requestedBy;
    } else if (settings.enabled && settings.autoApply && updateAvailable) {
      shouldUpdate = true;
      reason = "auto";
    }

    return {
      shouldUpdate,
      reason,
      requestedBy,
      updateAvailable,
      currentVersion: BUILD.version,
      currentCommit: BUILD.commit,
      latest,
      enabled: settings.enabled,
      autoApply: settings.autoApply,
      repo: settings.repo,
      lastCheckedAt: this.lastCheckedAt,
      lastCheckError: this.lastCheckError,
    };
  }

  // ── Manual trigger ─────────────────────────────────────────

  async requestUpdate(requestedBy: string): Promise<UpdateStatus> {
    const status = await this.getStatus(true);
    if (!status.updateAvailable) return status;

    await this.redis.set(
      MANUAL_UPDATE_KEY,
      { requestedBy, targetVersion: status.latest!.version, requestedAt: Date.now() },
      MANUAL_UPDATE_TTL_SECONDS,
    );
    return this.getStatus();
  }

  async cancelUpdate(): Promise<void> {
    await this.redis.del(MANUAL_UPDATE_KEY);
  }

  // ── History ────────────────────────────────────────────────

  /**
   * Called by the updater the moment it commits to updating — i.e. *before*
   * it rebuilds and restarts this container. Clearing the manual flag here
   * (rather than after) is what stops the same update running twice: the
   * process that would report success is the one being killed.
   */
  async recordUpdateStarted(
    toVersion: string,
    trigger: "manual" | "auto",
    requestedBy: string | null,
  ): Promise<string> {
    await this.cancelUpdate();
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO update_history (from_version, to_version, trigger, requested_by, status)
       VALUES ($1, $2, $3, $4, 'started')
       RETURNING id`,
      [BUILD.version, toVersion, trigger, requestedBy],
    );
    console.log(`[update] update to ${toVersion} started (${trigger})`);
    return row!.id;
  }

  /**
   * Reported by the updater after the new stack is up (or after it gave up).
   * On success this call reaches the *new* container, which is why the row id
   * is passed back rather than tracked in memory.
   */
  async recordUpdateFinished(
    id: string,
    status: "ok" | "error",
    error: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE update_history
       SET status = $2, error = $3, finished_at = NOW()
       WHERE id = $1`,
      [id, status, error],
    );
  }

  /** Any update row left in 'started' from a crashed/killed attempt. */
  async reconcileInterrupted(): Promise<void> {
    await this.db.query(
      `UPDATE update_history
       SET status = 'error',
           error = 'Interrupted — no result reported before the next restart.',
           finished_at = NOW()
       WHERE status = 'started' AND started_at < NOW() - INTERVAL '30 minutes'`,
    );
  }

  async listHistory(limit = 20): Promise<any[]> {
    return this.db.all(
      `SELECT id, from_version, to_version, trigger, requested_by, status, error,
              started_at, finished_at
       FROM update_history
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit],
    );
  }
}
