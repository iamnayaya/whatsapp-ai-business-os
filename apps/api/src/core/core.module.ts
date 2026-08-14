import { Global, Module } from '@nestjs/common';
import { createPrismaClient } from '../../../../packages/db/src';
import { createAuditService } from '../../../../packages/audit/src';
import { createWhatsappMessageQueue, createPaymentEventQueue } from '../../../../packages/queue/src';
import { createLogger } from '../../../../packages/shared/src';
import type { Env } from '../../../../packages/shared/src';
import { APP_CONFIG_TOKEN, AUDIT, LOGGER, PRISMA, QUEUE, PAYMENT_QUEUE } from '../tokens';
import { APP_CONFIG } from '../config';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG_TOKEN, useValue: APP_CONFIG as Env },
    { provide: PRISMA, useFactory: () => createPrismaClient() },
    {
      provide: QUEUE,
      useFactory: (config: Env) => createWhatsappMessageQueue({ url: config.REDIS_URL }),
      inject: [APP_CONFIG_TOKEN],
    },
    {
      provide: PAYMENT_QUEUE,
      useFactory: (config: Env) => createPaymentEventQueue({ url: config.REDIS_URL }),
      inject: [APP_CONFIG_TOKEN],
    },
    {
      provide: AUDIT,
      useFactory: (prisma: ReturnType<typeof createPrismaClient>, logger: ReturnType<typeof createLogger>) =>
        createAuditService({ prisma, logger }),
      inject: [PRISMA, LOGGER],
    },
    { provide: LOGGER, useFactory: () => createLogger('api') },
  ],
  exports: [APP_CONFIG_TOKEN, PRISMA, QUEUE, PAYMENT_QUEUE, AUDIT, LOGGER],
})
export class CoreModule {}