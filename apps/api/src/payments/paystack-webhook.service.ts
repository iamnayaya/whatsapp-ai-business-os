import { Injectable } from '@nestjs/common';
import type { PrismaClient } from '../../../../packages/db/src';
import type { AppLogger } from '../../../../packages/shared/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  EVENT_STATUS,
  isUniqueConstraintError,
} from '../../../../packages/shared/src';
import type { Env } from '../../../../packages/shared/src';
import type { Queue } from 'bullmq';
import type { PaystackWebhookPayload } from '../../../../packages/paystack/src';
import { verifyPaystackSignature } from '../../../../packages/paystack/src';
import { enqueuePaymentEvent, type PaymentEventJobData } from '../../../../packages/queue/src';
import type { AuditService } from '../../../../packages/audit/src';

export interface PaystackWebhookServiceDeps {
  prisma: PrismaClient;
  queue: Queue<PaymentEventJobData>;
  audit: AuditService;
  logger: AppLogger;
  config: Env;
}

interface CapturedEvent {
  id: string;
  existing: boolean;
  status?: string;
}

/**
 * Paystack webhook receiver (Phase 7). The controller verifies the HMAC-SHA512
 * signature before this service runs; here we persist the FULL raw payload to
 * the lossless events store (idempotency lock) and enqueue a payment-events
 * job with an eventKey-derived jobId so BullMQ also dedupes.
 *
 * The raw event is left PENDING — the worker marks it PROCESSED after the
 * order/stock/confirmation work completes, so a crash mid-processing leaves a
 * visible unprocessed backlog instead of silently losing money events.
 */
@Injectable()
export class PaystackWebhookService {
  constructor(private readonly deps: PaystackWebhookServiceDeps) {}

  /** True only when the request body was signed by someone holding the secret key. */
  verifySignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    const secret = this.deps.config.PAYSTACK_SECRET_KEY;
    if (!secret || !signature) return false;
    return verifyPaystackSignature({ rawBody, signature, secret });
  }

  async handleWebhook(payload: PaystackWebhookPayload): Promise<void> {
    const { event, data } = payload;
    const eventKey = `paystack:${event}:${data.id ?? data.reference}`;

    const captured = await this.captureRawEvent(eventKey, payload);
    if (captured.existing && captured.status === EVENT_STATUS.PROCESSED) {
      this.deps.logger.info('duplicate paystack event skipped (already processed)', { eventKey });
      return;
    }

    // Idempotent at BullMQ too: jobId = eventKey.
    await enqueuePaymentEvent({
      queue: this.deps.queue,
      data: { eventKey, event, data },
    });

    await this.deps.audit.record({
      businessId: 'unknown',
      actorType: AUDIT_ACTOR.WEBHOOK,
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_RECEIVED,
      entityType: 'PAYMENT_EVENT',
      entityId: eventKey,
      details: { event, reference: data.reference, eventKey },
    });
  }

  private async captureRawEvent(eventKey: string, payload: unknown): Promise<CapturedEvent> {
    try {
      const created = await this.deps.prisma.incomingEvent.create({
        data: { eventKey, type: `payment:${(payload as { event?: string }).event ?? 'unknown'}`, payload: payload as object },
      });
      return { id: created.id, existing: false };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await this.deps.prisma.incomingEvent.findUnique({ where: { eventKey } });
      if (!existing) throw err;
      return { id: existing.id, existing: true, status: existing.status };
    }
  }
}