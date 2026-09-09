// db/Redis.ts
import { createClient, RedisClientType } from "redis";

export class Redis {
  private client: RedisClientType;
  private connected: boolean = false;

  constructor(url?: string) {
    this.client = createClient({
      url: url || process.env.REDIS_URL || "redis://redis:6379",
    });

    this.client.on("error", (err) => {
      console.error("Redis error:", err);
    });
  }

  async connect() {
    if (this.connected) return;

    await this.client.connect();
    this.connected = true;
  }

  async get<T = any>(key: string): Promise<T | null> {
    const value = await this.client.get(key);

    if (typeof value !== "string") {
      return null;
    }

    return JSON.parse(value) as T;
  }

  async set(key: string, value: any, ttlSeconds?: number) {
    const serialized = JSON.stringify(value);

    if (ttlSeconds) {
      await this.client.set(key, serialized, {
        EX: ttlSeconds,
      });
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async exists(key: string) {
    return (await this.client.exists(key)) === 1;
  }

  async close() {
    await this.client.quit();
  }

  async increment(key: string): Promise<number> {
    return this.client.incr(key);
  }
  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Deletes every key matching `pattern` via non-blocking SCAN + batched DEL.
   * Never KEYS — that blocks the whole Redis event loop on a large keyspace.
   * Returns the number of keys actually deleted.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    let deleted = 0;

    // scanIterator already yields keys in COUNT-sized batches per cursor
    // step, so each batch is deleted as it arrives rather than buffered.
    for await (const batch of this.client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      if (batch.length) {
        deleted += await this.client.del(batch);
      }
    }
    return deleted;
  }
}