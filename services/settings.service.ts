// settings.service.ts
import crypto from "crypto";
import { Database } from "../database/db.js";

// ── Types ────────────────────────────────────────────────────

export interface HostingPoint {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  last_synced_at: Date | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  created_at: Date;
  updated_at: Date;
}

// Light audit context (who/when) for an admin-disabled provider variant,
// stored as a slug -> info map under app_settings key 'disabled_providers'.
// A flag+metadata blob like this doesn't warrant a dedicated table the way
// hosting_points (genuinely relational) does.
export interface DisabledProviderInfo {
  disabledAt: string;
  disabledBy: string;
}
export type DisabledProvidersMap = Record<string, DisabledProviderInfo>;

const DEFAULT_SYNC_SETTINGS = {
  enabled: false,
  intervalMinutes: 15,
};

const DEFAULT_POWER_SETTINGS = {
  enabled: false,
  idleMinutes: 60,
  minUptimeMinutes: 30,
};

// What a native client is told about its own versioning, served publicly by
// /api/version. `minSupported` is the contract: below it, a client can no
// longer talk to this server correctly and must update. Defaults come from
// env so a fresh install is already correct; the admin API overrides them
// without a redeploy.
export interface ClientVersionSettings {
  /** newest client build available — clients below it may prompt */
  latest: string | null;
  /** oldest client build this server still accepts */
  minSupported: string | null;
  downloadUrl: string | null;
  notes: string | null;
  /** when true, requests from too-old clients are rejected with 426 */
  enforce: boolean;
  /** ISO timestamp of the last successful APK upload via
   *  POST /api/settings/client-version/apk, or null if none has ever
   *  happened / downloadUrl currently points at an external link. */
  apkUploadedAt: string | null;
  /** `latest` at the time of that upload — lets the admin UI notice when
   *  `latest` has since changed without a matching re-upload. */
  apkVersion: string | null;
}

const DEFAULT_CLIENT_VERSION_SETTINGS: ClientVersionSettings = {
  latest: null,
  minSupported: null,
  downloadUrl: null,
  notes: null,
  enforce: false,
  apkUploadedAt: null,
  apkVersion: null,
};

// ── SettingsService ──────────────────────────────────────────

export class SettingsService {
  constructor(private readonly db: Database) {}

  // ── Hosting points ─────────────────────────────────────────
  // shared_secret is write-only from the API's perspective: it's accepted on
  // create/update but never returned in list/get responses.

  private readonly hostingPointColumns = `
    id, name, url, enabled, last_synced_at, last_sync_status, last_sync_error,
    created_at, updated_at
  `;

  async listHostingPoints(): Promise<HostingPoint[]> {
    return this.db.all<HostingPoint>(
      `SELECT ${this.hostingPointColumns} FROM hosting_points ORDER BY created_at ASC`,
    );
  }

  async getHostingPoint(id: string): Promise<HostingPoint | null> {
    return this.db.one<HostingPoint>(
      `SELECT ${this.hostingPointColumns} FROM hosting_points WHERE id = $1`,
      [id],
    );
  }

  // Returns the shared secret alongside the row — only on creation. It's the
  // one moment the admin needs the raw value, to paste into the peer's own
  // hosting-points entry for this server; every other read omits it.
  async addHostingPoint(
    name: string,
    url: string,
    sharedSecret?: string,
  ): Promise<HostingPoint & { shared_secret: string }> {
    const secret =
      sharedSecret?.trim() || crypto.randomBytes(32).toString("hex");
    const row = await this.db.one<HostingPoint>(
      `INSERT INTO hosting_points (name, url, shared_secret)
       VALUES ($1, $2, $3)
       RETURNING ${this.hostingPointColumns}`,
      [name, url, secret],
    );
    return { ...row!, shared_secret: secret };
  }

  async updateHostingPoint(
    id: string,
    updates: {
      name?: string;
      url?: string;
      sharedSecret?: string;
      enabled?: boolean;
    },
  ): Promise<HostingPoint | null> {
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (updates.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(updates.name);
    }
    if (updates.url !== undefined) {
      sets.push(`url = $${i++}`);
      params.push(updates.url);
    }
    if (updates.sharedSecret !== undefined) {
      sets.push(`shared_secret = $${i++}`);
      params.push(updates.sharedSecret);
    }
    if (updates.enabled !== undefined) {
      sets.push(`enabled = $${i++}`);
      params.push(updates.enabled);
    }

    if (sets.length === 0) {
      return this.getHostingPoint(id);
    }

    params.push(id);
    return this.db.one<HostingPoint>(
      `UPDATE hosting_points SET ${sets.join(", ")} WHERE id = $${i}
       RETURNING ${this.hostingPointColumns}`,
      params,
    );
  }

  async removeHostingPoint(id: string): Promise<void> {
    await this.db.query(`DELETE FROM hosting_points WHERE id = $1`, [id]);
  }

  async markSyncResult(
    id: string,
    status: "ok" | "error",
    error: string | null,
    syncedAt: Date,
  ): Promise<void> {
    await this.db.query(
      `UPDATE hosting_points
       SET last_synced_at = $2, last_sync_status = $3, last_sync_error = $4
       WHERE id = $1`,
      [id, syncedAt, status, error],
    );
  }

  // ── Peer authentication ───────────────────────────────────
  // Looks up an enabled hosting point by the shared secret a peer presented.

  async findHostingPointBySecret(
    secret: string,
  ): Promise<{ id: string; name: string } | null> {
    return this.db.one<{ id: string; name: string }>(
      `SELECT id, name FROM hosting_points WHERE shared_secret = $1 AND enabled = TRUE`,
      [secret],
    );
  }

  // ── Sync settings (app-wide) ──────────────────────────────

  async getSyncSettings(): Promise<{
    enabled: boolean;
    intervalMinutes: number;
  }> {
    const row = await this.db.one<{ value: any }>(
      `SELECT value FROM app_settings WHERE key = 'sync'`,
    );
    if (!row) return { ...DEFAULT_SYNC_SETTINGS };
    return { ...DEFAULT_SYNC_SETTINGS, ...row.value };
  }

  async setSyncSettings(updates: {
    enabled?: boolean;
    intervalMinutes?: number;
  }): Promise<{
    enabled: boolean;
    intervalMinutes: number;
  }> {
    const current = await this.getSyncSettings();
    const next = { ...current };
    if (updates.enabled !== undefined) next.enabled = updates.enabled;
    if (updates.intervalMinutes !== undefined)
      next.intervalMinutes = updates.intervalMinutes;
    await this.db.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('sync', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }

  // ── Power / auto-shutdown settings (app-wide) ─────────────────

  async getPowerSettings(): Promise<{
    enabled: boolean;
    idleMinutes: number;
    minUptimeMinutes: number;
  }> {
    const row = await this.db.one<{ value: any }>(
      `SELECT value FROM app_settings WHERE key = 'power'`,
    );
    if (!row) return { ...DEFAULT_POWER_SETTINGS };
    return { ...DEFAULT_POWER_SETTINGS, ...row.value };
  }

  async setPowerSettings(updates: {
    enabled?: boolean;
    idleMinutes?: number;
    minUptimeMinutes?: number;
  }): Promise<{
    enabled: boolean;
    idleMinutes: number;
    minUptimeMinutes: number;
  }> {
    const current = await this.getPowerSettings();
    const next = { ...current };
    if (updates.enabled !== undefined) next.enabled = updates.enabled;
    if (updates.idleMinutes !== undefined)
      next.idleMinutes = updates.idleMinutes;
    if (updates.minUptimeMinutes !== undefined)
      next.minUptimeMinutes = updates.minUptimeMinutes;
    await this.db.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('power', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }

  // ── Client version policy (app-wide) ──────────────────────────

  async getClientVersionSettings(): Promise<ClientVersionSettings> {
    const row = await this.db.one<{ value: any }>(
      `SELECT value FROM app_settings WHERE key = 'client_version'`,
    );
    const stored: ClientVersionSettings = {
      ...DEFAULT_CLIENT_VERSION_SETTINGS,
      ...(row?.value ?? {}),
    };
    // Env is only a fallback — a stored value always wins, so an admin can
    // roll the floor back without touching the deployment.
    if (stored.latest === null) stored.latest = process.env.CLIENT_LATEST_VERSION?.trim() || null;
    if (stored.minSupported === null)
      stored.minSupported = process.env.CLIENT_MIN_VERSION?.trim() || null;
    if (stored.downloadUrl === null)
      stored.downloadUrl = process.env.CLIENT_DOWNLOAD_URL?.trim() || null;
    return stored;
  }

  async setClientVersionSettings(
    updates: Partial<ClientVersionSettings>,
  ): Promise<ClientVersionSettings> {
    const current = await this.getClientVersionSettings();
    const next: ClientVersionSettings = { ...current };
    if (updates.latest !== undefined) next.latest = updates.latest?.trim() || null;
    if (updates.minSupported !== undefined)
      next.minSupported = updates.minSupported?.trim() || null;
    if (updates.downloadUrl !== undefined)
      next.downloadUrl = updates.downloadUrl?.trim() || null;
    if (updates.notes !== undefined) next.notes = updates.notes ?? null;
    if (updates.enforce !== undefined) next.enforce = updates.enforce;
    if (updates.apkUploadedAt !== undefined) next.apkUploadedAt = updates.apkUploadedAt;
    if (updates.apkVersion !== undefined) next.apkVersion = updates.apkVersion;

    await this.db.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('client_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }

  // ── Disabled providers (app-wide) ──────────────────────────────

  async getDisabledProviders(): Promise<DisabledProvidersMap> {
    const row = await this.db.one<{ value: any }>(
      `SELECT value FROM app_settings WHERE key = 'disabled_providers'`,
    );
    return row?.value ?? {};
  }

  async setProviderDisabled(
    slug: string,
    disabled: boolean,
    adminEmail: string,
  ): Promise<DisabledProvidersMap> {
    const current = await this.getDisabledProviders();
    const next: DisabledProvidersMap = { ...current };
    if (disabled) {
      next[slug] = { disabledAt: new Date().toISOString(), disabledBy: adminEmail };
    } else {
      delete next[slug];
    }
    await this.db.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('disabled_providers', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(next)],
    );
    return next;
  }
}
