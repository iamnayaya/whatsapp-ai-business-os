import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { PrismaClient } from '../../../../packages/db/src';
import type { Env } from '../../../../packages/shared/src';
import { AnalyticsService } from '../../../../packages/analytics/src';
import { ANALYTICS_PRISMA, APP_CONFIG_TOKEN, PRISMA, AUDIT, LOGGER } from '../tokens';
import { AnalyticsController } from './analytics.controller';
import { CatalogUploadController } from './catalog-upload.controller';
import { CatalogUploadService } from './catalog-upload.service';
import { AdminAuthService, type AdminAuthConfig } from './admin-auth.service';

const DASHBOARD_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Phase 8 — Owner Analytics Dashboard. Read-only by construction: the service
 * only issues SELECT queries. When ANALYTICS_DATABASE_URL is set, the dashboard
 * gets its OWN PrismaClient pointed at that URL (a replica or a SELECT-only
 * role), so it can never write to the primary database.
 *
 * Also includes catalog upload functionality (Phase 10) — write-enabled
 * product creation with human review gate, protected by the same admin auth.
 */
@Module({
  controllers: [AnalyticsController, CatalogUploadController],
  providers: [
    {
      provide: ANALYTICS_PRISMA,
      useFactory: (config: Env, shared: PrismaClient): PrismaClient => {
        if (config.ANALYTICS_DATABASE_URL) {
          return new PrismaClient({
            datasources: { db: { url: config.ANALYTICS_DATABASE_URL } },
            log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
          });
        }
        return shared;
      },
      inject: [APP_CONFIG_TOKEN, PRISMA],
    },
    {
      provide: AnalyticsService,
      useFactory: (config: Env, prisma: PrismaClient) =>
        new AnalyticsService({ prisma, timeZone: config.BUSINESS_TIMEZONE }),
      inject: [APP_CONFIG_TOKEN, ANALYTICS_PRISMA],
    },
    {
      provide: AdminAuthService,
      useFactory: (config: Env): AdminAuthService | null => {
        // Fail-closed: no password in env = dashboard disabled (routes 404).
        if (!config.ADMIN_PASSWORD) return null;
        return new AdminAuthService({
          password: config.ADMIN_PASSWORD,
          sessionSecret: config.ADMIN_SESSION_SECRET ?? config.ADMIN_PASSWORD,
          cookieName: 'wabiz_admin',
          maxAgeMs: DASHBOARD_SESSION_MAX_AGE_MS,
        } satisfies AdminAuthConfig);
      },
      inject: [APP_CONFIG_TOKEN],
    },
    CatalogUploadService,
  ],
})
export class AnalyticsModule implements OnApplicationShutdown {
  constructor(
    @Inject(ANALYTICS_PRISMA) private readonly analyticsPrisma: PrismaClient,
    @Inject(PRISMA) private readonly sharedPrisma: PrismaClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Only a dedicated read-only client is ours to close; the shared one is
    // owned by CoreModule.
    if (this.analyticsPrisma !== this.sharedPrisma) {
      await this.analyticsPrisma.$disconnect();
    }
  }
}