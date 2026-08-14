import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { createKillSwitch } from '../../../../packages/ops/src';
import { createLogger, type Env } from '../../../../packages/shared/src';
import { APP_CONFIG_TOKEN, KILL_SWITCH, LOGGER } from '../tokens';
import { AdminAuthService, type AdminAuthConfig } from '../analytics/admin-auth.service';
import { OpsController } from './ops.controller';

const OPS_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const OPS_REDIS = Symbol('OPS_REDIS');

/**
 * Phase 9 — operational controls. Hosts the AI-agent kill switch endpoints
 * behind the same password auth as the owner dashboard. Its own lazily
 * connected Redis client (shared with nothing else) is closed on shutdown.
 */
@Module({
  controllers: [OpsController],
  providers: [
    {
      provide: OPS_REDIS,
      useFactory: (config: Env): Redis => {
        const redis = new Redis(config.REDIS_URL, { lazyConnect: true, retryStrategy: (times) => Math.min(times * 1000, 10_000) });
        redis.on('error', () => undefined); // surfaced via command results
        return redis;
      },
      inject: [APP_CONFIG_TOKEN],
    },
    {
      provide: KILL_SWITCH,
      useFactory: (redis: Redis, logger: ReturnType<typeof createLogger>) =>
        createKillSwitch({ redis, logger: logger.child('ops') }),
      inject: [OPS_REDIS, LOGGER],
    },
    {
      provide: AdminAuthService,
      useFactory: (config: Env): AdminAuthService | null => {
        // Fail-closed: no password in env = endpoints 404 (same as dashboard).
        if (!config.ADMIN_PASSWORD) return null;
        return new AdminAuthService({
          password: config.ADMIN_PASSWORD,
          sessionSecret: config.ADMIN_SESSION_SECRET ?? config.ADMIN_PASSWORD,
          cookieName: 'wabiz_admin',
          maxAgeMs: OPS_SESSION_MAX_AGE_MS,
        } satisfies AdminAuthConfig);
      },
      inject: [APP_CONFIG_TOKEN],
    },
  ],
})
export class OpsModule implements OnApplicationShutdown {
  constructor(@Inject(OPS_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}