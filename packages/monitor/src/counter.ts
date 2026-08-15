/**
 * A windowed counter backed by Redis, used to detect error *spikes*.
 *
 * Each `inc` lands in a fixed-size time bucket keyed by
 * `prefix:<label>:<bucketIndex>` (bucketIndex = floor(ts / bucketMs)). Reads
 * sum the buckets that fall inside the requested window. Bucket keys expire
 * shortly after they roll out of the window so Redis never accumulates keys.
 */

export interface CounterRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  mget(keys: string[]): Promise<Array<string | null>>;
}

export interface RedisCounter {
  inc(label: string, atMs?: number): Promise<void>;
  /** Sum of counts for `label` in [sinceMs, now]. */
  read(label: string, sinceMs: number, nowMs?: number): Promise<number>;
}

export interface RedisCounterConfig {
  redis: CounterRedis;
  prefix: string;
  bucketMs: number;
}

export function createRedisCounter({ redis, prefix, bucketMs }: RedisCounterConfig): RedisCounter {
  const keyOf = (label: string, bucket: number) => `${prefix}:${label}:${bucket}`;

  return {
    async inc(label, atMs = Date.now()) {
      const bucket = Math.floor(atMs / bucketMs);
      const key = keyOf(label, bucket);
      await redis.incr(key);
      // Keys live for 2 bucket windows, then expire naturally.
      await redis.expire(key, Math.max(2, Math.ceil((2 * bucketMs) / 1000)));
    },
    async read(label, sinceMs, nowMs = Date.now()) {
      const fromBucket = Math.floor(sinceMs / bucketMs);
      const toBucket = Math.floor(nowMs / bucketMs);
      const keys: string[] = [];
      for (let b = fromBucket; b <= toBucket; b++) keys.push(keyOf(label, b));
      const values = await redis.mget(keys);
      return values.reduce((sum, v) => sum + (v ? parseInt(v, 10) : 0), 0);
    },
  };
}