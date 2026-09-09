// db/Database.ts
import pg from "pg";

const { Pool } = pg;

export class Database {
  private pool: pg.Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  async query<T = any>(text: string, params?: any[]) {
    return this.pool.query<T>(text, params);
  }

  async one<T = any>(text: string, params?: any[]) {
    const res = await this.pool.query<T>(text, params);
    return res.rows[0] ?? null;
  }

  async all<T = any>(text: string, params?: any[]) {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  async close() {
    await this.pool.end();
  }

  /**
   * Runs `fn` against a single pooled connection. Needed for anything that
   * is session-scoped rather than statement-scoped — notably advisory locks,
   * which are held by the connection that took them, so lock and unlock
   * issued through `query()` could land on two different clients.
   */
  async withClient<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}