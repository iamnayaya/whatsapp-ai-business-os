import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService, type WebhookServiceDeps } from './webhook.service';
import { WebhookSignatureService, type WebhookSignatureConfig } from './webhook-signature.service';
import type { PrismaClient } from '../../../../packages/db/src';
import type { AppLogger, Env } from '../../../../packages/shared/src';
import type { AuditService } from '../../../../packages/audit/src';
import type { InboundMessageJobData } from '../../../../packages/queue/src';
import { APP_CONFIG_TOKEN, AUDIT, LOGGER, PRISMA, QUEUE } from '../tokens';
import type { Queue } from 'bullmq';

@Module({
  controllers: [WebhookController],
  providers: [
    {
      provide: WebhookSignatureService,
      useFactory: (config: Env) =>
        new WebhookSignatureService({
          appSecret: config.WHATSAPP_APP_SECRET,
          verifyToken: config.WHATSAPP_VERIFY_TOKEN,
        } as WebhookSignatureConfig),
      inject: [APP_CONFIG_TOKEN],
    },
    {
      provide: WebhookService,
      useFactory: (
        config: Env,
        prisma: PrismaClient,
        queue: Queue<InboundMessageJobData>,
        audit: AuditService,
        logger: AppLogger,
      ) => new WebhookService({ config, prisma, queue, audit, logger } as WebhookServiceDeps),
      inject: [APP_CONFIG_TOKEN, PRISMA, QUEUE, AUDIT, LOGGER],
    },
  ],
})
export class WebhookModule {}