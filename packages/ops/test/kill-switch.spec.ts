import { describe, expect, it, vi } from 'vitest';
import { createKillSwitch, KILL_SWITCH_KEY, type KillSwitchRedis } from '../src/kill-switch';
import { createLogger } from '../../shared/src/logger';

const silentLogger = createLogger('test', { destination: () => undefined });

function makeRedis(initial: string | null = null) {
  let value = initial;
  let ttl = -1;
  const get = vi.fn(async () => value);
  const set = vi.fn(async (key: string, v: string) => {
    value = v;
    ttl = -1;
    return 'OK' as const;
  });
  const expire = vi.fn(async (key: string, seconds: number) => {
    ttl = seconds;
    return 1;
  });
  const del = vi.fn(async () => {
    value = null;
    ttl = -1;
    return 1;
  });
  const ttlFn = vi.fn(async () => ttl);
  return { get, set, expire, del, ttl: ttlFn } as unknown as KillSwitchRedis;
}

describe('createKillSwitch', () => {
  it('is inactive when the key is missing', async () => {
    const ks = createKillSwitch({ redis: makeRedis(null), logger: silentLogger });
    await expect(ks.isActive()).resolves.toBe(false);
    await expect(ks.status()).resolves.toEqual({ active: false, ttlSeconds: null });
  });

  it('is active when the key is set', async () => {
    const ks = createKillSwitch({ redis: makeRedis('1'), logger: silentLogger });
    await expect(ks.isActive()).resolves.toBe(true);
  });

  it('activate() sets the key (persistent when no TTL given)', async () => {
    const redis = makeRedis(null);
    const ks = createKillSwitch({ redis, logger: silentLogger });

    await ks.activate();

    expect(redis.set).toHaveBeenCalledWith(KILL_SWITCH_KEY, '1');
    await expect(ks.isActive()).resolves.toBe(true);
    await expect(ks.status()).resolves.toEqual({ active: true, ttlSeconds: null });
  });

  it('activate(ttlSeconds) sets an expiry and reports it', async () => {
    const redis = makeRedis(null);
    const ks = createKillSwitch({ redis, logger: silentLogger });

    await ks.activate(3600);

    expect(redis.set).toHaveBeenCalledWith(KILL_SWITCH_KEY, '1');
    expect(redis.expire).toHaveBeenCalledWith(KILL_SWITCH_KEY, 3600);
    await expect(ks.status()).resolves.toEqual({ active: true, ttlSeconds: 3600 });
  });

  it('deactivate() clears the key', async () => {
    const redis = makeRedis('1');
    const ks = createKillSwitch({ redis, logger: silentLogger });

    await ks.deactivate();

    expect(redis.del).toHaveBeenCalledWith(KILL_SWITCH_KEY);
    await expect(ks.isActive()).resolves.toBe(false);
  });
});