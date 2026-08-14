import { Module } from '@nestjs/common';
import { PaystackController } from './paystack.controller';
import { PaystackWebhookService, type PaystackWebhookServiceDeps } from './paystack-webhook.service';
import type { PrismaClient } from '../../../../packages/db/src';
import type { AppLogger, Env } from '../../../../packages/shared/src';
import type { AuditService } from '../../../../packages/audit/src';
import type { PaymentEventJobData } from '../../../../packages/queue/src';
import { APP_CONFIG_TOKEN, AUDIT, LOGGER, PAYMENT_QUEUE, PRISMA } from '../tokens';
import type { Queue } from 'bullmq';

@Module({
  controllers: [PaystackController],
  providers: [
    {
      provide: PaystackWebhookService,
      useFactory: (
        config: Env,
        prisma: PrismaClient,
        queue: Queue<PaymentEventJobData>,
        audit: AuditService,
        logger: AppLogger,
      ) => new PaystackWebhookService({ config, prisma, queue, audit, logger } as PaystackWebhookServiceDeps),
      inject: [APP_CONFIG_TOKEN, PRISMA, PAYMENT_QUEUE, AUDIT, LOGGER],
    },
  ],
})
export class PaymentsModule {}