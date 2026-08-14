import type { AppLogger } from '../../shared/src/logger';

/**
 * AI-agent kill switch (Redis-backed).
 *
 * When ACTIVE, the worker answers every inbound customer message with a static
 * "we'll reply shortly" fallback and does NOT call Gemini — while webhook
 * reception, payment processing, and follow-ups keep running untouched.
 *
 * Toggled via POST /admin/ops/kill-switch (see apps/api/src/ops) or directly
 * with the Redis CLI as an emergency failsafe:
 *
 *   redis-cli SET ops:kill-switch 1          # pause the AI agent
 *   redis-cli SET ops:kill-switch 1 EX 3600  # pause for one hour (auto-resume)
 *   redis-cli DEL ops:kill-switch            # resume the AI agent
 */

export const KILL_SWITCH_KEY = 'ops:kill-switch';

export const KILL_SWITCH_REPLY_TEXT = "Thanks for your message — we'll reply shortly.";

export interface KillSwitchRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<'OK' | null>;
  /** Set an expiry on an existing key (seconds). */
  expire(key: string, seconds: number): Promise<number>;
  del(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
}

export interface KillSwitchStatus {
  active: boolean;
  /** null = no expiry (paused until explicitly resumed). */
  ttlSeconds: number | null;
}

export interface KillSwitch {
  isActive(): Promise<boolean>;
  /** `ttlSeconds` unset/0 = persistent (paused until deactivated). */
  activate(ttlSeconds?: number): Promise<void>;
  deactivate(): Promise<void>;
  status(): Promise<KillSwitchStatus>;
}

export function createKillSwitch({ redis, logger }: { redis: KillSwitchRedis; logger: AppLogger }): KillSwitch {
  return {
    async isActive() {
      return (await redis.get(KILL_SWITCH_KEY)) === '1';
    },
    async activate(ttlSeconds) {
      await redis.set(KILL_SWITCH_KEY, '1');
      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await redis.expire(KILL_SWITCH_KEY, ttlSeconds);
      }
      logger.warn('AI agent kill switch ACTIVATED', { ttlSeconds: ttlSeconds ?? null });
    },
    async deactivate() {
      await redis.del(KILL_SWITCH_KEY);
      logger.info('AI agent kill switch DEACTIVATED');
    },    async status() {
      const value = await redis.get(KILL_SWITCH_KEY);
      if (value !== '1') return { active: false, ttlSeconds: null };
      const remaining = await redis.ttl(KILL_SWITCH_KEY);
      return { active: true, ttlSeconds: remaining === -1 ? null : remaining };
    },
  };
}