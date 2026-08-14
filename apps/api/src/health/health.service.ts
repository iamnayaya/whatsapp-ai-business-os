import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { PrismaClient } from '../../../../packages/db/src';
import type { Env } from '../../../../packages/shared/src';
import { APP_CONFIG_TOKEN, PRISMA } from '../tokens';

export interface HealthResult {
  status: 'ok' | 'degraded';
  database: 'up' | 'down';
  redis: 'up' | 'down';
  details: Record<string, unknown>;
}

/**
 * One shared, lazily-connected Redis client for health checks. The previous
 * implementation opened a fresh connection per /health request — a public,
 * unauthenticated connection-exhaustion vector. The error strings echoed into
 * `details` are limited to non-production so no DB/Redis internals leak.
 */
@Injectable()
export class HealthService implements OnApplicationShutdown {
  private readonly redis: Redis;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG_TOKEN) private readonly config: Env,
  ) {
    this.redis = new Redis(this.config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // no infinite reconnect storm
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => undefined); // surfaced via the try/catch below
  }

  async check(): Promise<HealthResult> {
    const [db, redis] = await Promise.allSettled([this.checkDb(), this.checkRedis()]);
    const reasonOf = (r: PromiseSettledResult<void>) =>
      r.status === 'fulfilled' ? 'up' : this.config.NODE_ENV === 'production' ? 'down' : (r.reason as Error).message;
    const details: Record<string, unknown> = {
      database: reasonOf(db),
      redis: reasonOf(redis),
    };
    const up = details.database === 'up' && details.redis === 'up';
    return {
      status: up ? 'ok' : 'degraded',
      database: details.database === 'up' ? 'up' : 'down',
      redis: details.redis === 'up' ? 'up' : 'down',
      details,
    };
  }

  private async checkDb(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  private async checkRedis(): Promise<void> {
    try {
      if (this.redis.status === 'end' || this.redis.status === 'close') {
        await this.redis.connect();
      }
      const pong = await this.redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected ping response: ${pong}`);
    } catch (err) {
      this.redis.disconnect();
      throw err;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
  }
}