// database/migrator.ts
//
// Applies the SQL files in database/migrations/ to the database, in order,
// exactly once each. Runs at boot (index.ts) before the server starts
// listening, so deploying a new build is enough to bring an existing install's
// schema up to date — the old path (Postgres' docker-entrypoint-initdb.d)
// only ever fires on a *fresh* volume, which meant schema changes silently
// never reached any install that already had data.
//
// Rules for writing a migration:
//   - file name is `<number>_<name>.sql`, e.g. `002_add_devices.sql`
//   - numbers are strictly increasing and never reused
//   - once committed and deployed, a migration file is immutable — write a
//     new one instead of editing it (the checksum check below flags edits)
//   - each file runs inside a single transaction, so it either fully applies
//     or not at all
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import type { Database } from "./db.js";

// Arbitrary but fixed: every instance takes this same advisory lock, so two
// containers booting at once can't run the same migration twice.
const MIGRATION_LOCK_ID = 8_427_101;

const MIGRATIONS_DIR = path.join(process.cwd(), "database", "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  baselined: string[];
}

interface MigrationFile {
  version: string; // zero-padded numeric prefix, e.g. "001"
  name: string;    // full file name
  sql: string;
  checksum: string;
}

function loadMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (!match) {
        throw new Error(
          `Migration "${name}" must be named <number>_<name>.sql (e.g. 002_add_devices.sql).`,
        );
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
      return {
        version: match[1]!,
        name,
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16),
      };
    })
    .sort((a, b) => Number(a.version) - Number(b.version));
}

export class Migrator {
  constructor(private readonly db: Database) {}

  private async ensureLedger(client: pg.PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT        PRIMARY KEY,
        name       TEXT        NOT NULL,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /**
   * An install created before this migrator existed already has the full
   * 001 schema (Postgres ran init.sql on first boot) but an empty ledger.
   * Re-running 001 there would be harmless — it's all IF NOT EXISTS — but
   * the same isn't true of migrations in general, so record it as applied
   * rather than replaying it, and let the real migrations start from 002.
   */
  private async needsBaseline(client: pg.PoolClient): Promise<boolean> {
    const ledger = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM schema_migrations`,
    );
    if (Number(ledger.rows[0]?.count ?? 0) > 0) return false;

    const existing = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'users'
       ) AS exists`,
    );
    return existing.rows[0]?.exists === true;
  }

  async run(): Promise<MigrationResult> {
    const files = loadMigrationFiles();
    const result: MigrationResult = { applied: [], skipped: [], baselined: [] };

    // One connection for the whole run: the advisory lock lives on the
    // session that took it, and every migration below runs under it.
    await this.db.withClient(async (client) => {
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_ID]);
      try {
        await this.ensureLedger(client);

        const baseline = await this.needsBaseline(client);

        type LedgerRow = { version: string; name: string; checksum: string };
        const rows = await client.query<LedgerRow>(
          `SELECT version, name, checksum FROM schema_migrations`,
        );
        const applied = new Map<string, LedgerRow>(
          rows.rows.map((r) => [r.version, r]),
        );

        for (const file of files) {
          const previous = applied.get(file.version);

          if (previous) {
            if (previous.checksum !== file.checksum) {
              // Someone edited an already-applied migration. Don't refuse to
              // boot over it — the schema is whatever it is — but make the
              // drift impossible to miss in the logs.
              console.warn(
                `[migrator] WARNING: ${file.name} changed since it was applied ` +
                  `(recorded ${previous.checksum}, file ${file.checksum}). ` +
                  `Migrations are immutable once deployed — add a new file instead.`,
              );
            }
            result.skipped.push(file.name);
            continue;
          }

          // Baselining only covers the initial schema; anything newer is a
          // real migration that genuinely hasn't run on this database.
          if (baseline && file.version === "001") {
            await client.query(
              `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
              [file.version, file.name, file.checksum],
            );
            result.baselined.push(file.name);
            console.log(`[migrator] baselined ${file.name} (schema already present)`);
            continue;
          }

          console.log(`[migrator] applying ${file.name}...`);
          try {
            await client.query("BEGIN");
            await client.query(file.sql);
            await client.query(
              `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
              [file.version, file.name, file.checksum],
            );
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(
              `Migration ${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          result.applied.push(file.name);
        }
      } finally {
        await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_ID]);
      }
    });

    if (result.applied.length === 0) {
      console.log(`[migrator] schema up to date (${result.skipped.length} migrations)`);
    } else {
      console.log(`[migrator] applied ${result.applied.length} migration(s)`);
    }
    return result;
  }

  /** Current schema version, or null if nothing has been applied yet. */
  async currentVersion(): Promise<string | null> {
    const row = await this.db.one<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
    );
    return row?.version ?? null;
  }
}
