import { describe, expect, it, vi } from 'vitest';
import { createRedisCounter, type CounterRedis } from '../src/counter';

function makeRedis() {
  const store = new Map<string, number>();
  const expirations = new Map<string, number>();
  const redis: CounterRedis = {
    incr: vi.fn(async (key) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async (key, seconds) => {
      expirations.set(key, seconds);
      return 1;
    }),
    mget: vi.fn(async (keys: string[]) => keys.map((k) => (store.has(k) ? String(store.get(k)) : null))),
  };
  return { redis, store, expirations };
}

describe('createRedisCounter', () => {
  it('increments the bucket for the current time window and sets an expiry', async () => {
    const { redis, expirations } = makeRedis();
    const counter = createRedisCounter({ redis, prefix: 'm', bucketMs: 10_000 });

    await counter.inc('ai.error', 0);
    await counter.inc('ai.error', 1);

    expect(redis.incr).toHaveBeenCalledWith('m:ai.error:0');
    expect(redis.incr).toHaveBeenCalledTimes(2);
    expect(expirations.get('m:ai.error:0')).toBe(20);
  });

  it('puts later timestamps in later buckets', async () => {
    const { redis } = makeRedis();
    const counter = createRedisCounter({ redis, prefix: 'm', bucketMs: 10_000 });

    await counter.inc('ai.error', 9_999);
    await counter.inc('ai.error', 10_000);

    expect(redis.incr).toHaveBeenNthCalledWith(1, 'm:ai.error:0');
    expect(redis.incr).toHaveBeenNthCalledWith(2, 'm:ai.error:1');
  });

  it('read() sums the buckets that overlap the requested window', async () => {
    const { redis } = makeRedis();
    const counter = createRedisCounter({ redis, prefix: 'm', bucketMs: 10_000 });
    await counter.inc('ai.error', 0);
    await counter.inc('ai.error', 0);
    await counter.inc('ai.error', 10_000);
    await counter.inc('ai.error', 25_000);

    const total = await counter.read('ai.error', 20_000, 30_000);

    expect(redis.mget).toHaveBeenCalledWith(['m:ai.error:2', 'm:ai.error:3']);
    expect(total).toBe(1);
  });

  it('read() returns 0 when no buckets match', async () => {
    const { redis } = makeRedis();
    const counter = createRedisCounter({ redis, prefix: 'm', bucketMs: 10_000 });

    await expect(counter.read('ai.error', 0, 10_000)).resolves.toBe(0);
  });
});