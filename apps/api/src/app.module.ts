import { Module } from '@nestjs/common';
import { CoreModule } from './core/core.module';
import { WebhookModule } from './webhook/webhook.module';
import { PaymentsModule } from './payments/payments.module';
import { HealthModule } from './health/health.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { OpsModule } from './ops/ops.module';

@Module({
  imports: [CoreModule, WebhookModule, PaymentsModule, HealthModule, AnalyticsModule, OpsModule],
})
export class AppModule {}