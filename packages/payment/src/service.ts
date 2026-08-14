import { Prisma, type PrismaClient } from '../../db/src';
import type { AppLogger } from '../../shared/src';
import type { AuditService } from '../../audit/src';
import type { WhatsAppClient } from '../../whatsapp/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  CONVERSATION_STATUS,
  DELIVERY_STATUS,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  messageFromError,
  withRetry,
} from '../../shared/src';
import type { PaystackChargeData } from '../../paystack/src';
import { buildPaidConfirmation, generateTrackingReference } from './confirmation';

export interface PaymentServiceDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppClient;
  audit: AuditService;
  logger: AppLogger;
}

export type PaymentEventOutcome =
  | { kind: 'paid'; orderId: string; paymentId: string; trackingReference: string }
  | { kind: 'failed'; orderId: string; paymentId: string }
  | { kind: 'duplicate'; orderId?: string; paymentId?: string }
  | { kind: 'ignored'; reason: string }
  | { kind: 'rejected'; reason: string };

const NO_REFUND_STATUSES: string[] = [
  ORDER_STATUS.PAID,
  ORDER_STATUS.FULFILLING,
  ORDER_STATUS.FULFILLED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.REFUNDED,
];

/**
 * Server-side payment processing (Phase 7). Runs on the payment-events worker,
 * never on the webhook hot path.
 *
 * Security / idempotency model:
 *  - The AMOUNT is never trusted from the webhook. The Payment row was created
 *    with the order total by the create_payment_link tool, and we compare the
 *    event amount (kobo) against `payment.amount` before touching anything.
 *  - Claim-before-work: `payment.updateMany` with a status guard is the
 *    exactly-once lock. A re-delivered charge.success finds status SUCCESS and
 *    is a no-op.
 *  - Stock is deducted with an atomic conditional update
 *    (`where quantity >= qty`), so two customers paying for the last unit can
 *    never oversell — the loser's transaction rolls back and the order is
 *    cancelled with a STOCK_RACE_CONFLICT audit.
 *  - The confirmation WhatsApp message is guarded by `confirmationSentAt`
 *    (claimed atomically, reset on send failure). A retry re-enters through the
 *    already-claimed path and resends the confirmation because the flag is
 *    null, so a transient WhatsApp outage never loses the receipt.
 */
export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  async handleChargeEvent(payload: { event: string; data: PaystackChargeData }): Promise<PaymentEventOutcome> {
    const { event, data } = payload;
    if (!data?.reference) {
      this.deps.logger.error('paystack event missing reference', { event });
      return { kind: 'ignored', reason: 'missing_reference' };
    }
    if (event === 'charge.success') return this.handleChargeSuccess(data);
    if (event === 'charge.failed') return this.handleChargeFailed(data);
    this.deps.logger.info('paystack event ignored (not a charge event)', { event });
    return { kind: 'ignored', reason: `unsupported_event:${event}` };
  }

  private async handleChargeSuccess(data: PaystackChargeData): Promise<PaymentEventOutcome> {
    const { prisma, audit, logger } = this.deps;
    const payment = await prisma.payment.findUnique({ where: { reference: data.reference } });
    if (!payment) {
      // A webhook for a reference we never created — do not invent an order.
      logger.error('paystack charge.success for unknown reference', { reference: data.reference });
      await audit.record({
        businessId: 'unknown',
        actorType: AUDIT_ACTOR.WEBHOOK,
        action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_RECEIVED,
        entityType: 'PAYMENT',
        details: { event: 'charge.success', reference: data.reference, reason: 'unknown_reference' },
      });
      return { kind: 'ignored', reason: 'unknown_reference' };
    }

    const order = await prisma.order.findUnique({
      where: { id: payment.orderId },
      include: { items: { include: { product: true } }, business: true, customer: true },
    });
    if (!order) {
      logger.error('paystack charge.success for order that no longer exists', { orderId: payment.orderId, reference: data.reference });
      return { kind: 'ignored', reason: 'missing_order' };
    }

    // Amount must match what we initialized — the webhook never sets the price.
    const expectedKobo = Math.round(Number(payment.amount) * 100);
    const receivedKobo = Number(data.amount);
    if (Number.isFinite(receivedKobo) && receivedKobo !== expectedKobo) {
      logger.error('paystack amount mismatch', {
        reference: data.reference,
        expectedKobo,
        receivedKobo,
        orderId: payment.orderId,
      });
      await this.claimFailed(payment.id, data, `amount_mismatch expected=${expectedKobo} got=${receivedKobo}`);
      await audit.record({
        businessId: order.businessId,
        actorType: AUDIT_ACTOR.WEBHOOK,
        action: AUDIT_ACTIONS.PAYMENT_FAILED,
        entityType: 'PAYMENT',
        entityId: payment.id,
        details: { orderId: payment.orderId, reason: 'amount_mismatch', expectedKobo, receivedKobo },
      });
      return { kind: 'rejected', reason: 'amount_mismatch' };
    }

    // Claim exactly-once: the first processor wins; a duplicate delivery sees
    // status SUCCESS and is a no-op.
    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: { not: PAYMENT_STATUS.SUCCESS } },
      data: {
        status: PAYMENT_STATUS.SUCCESS,
        confirmedAt: new Date(),
        providerPayload: { data } as Prisma.InputJsonValue,
      },
    });

    if (claimed.count === 0) {
      logger.info('charge.success re-delivered — payment already confirmed', { reference: data.reference, orderId: payment.orderId });
      // This is either a duplicate webhook (confirmation already sent) or a
      // BullMQ retry after a failed confirmation send. Resend ONLY if the
      // confirmation never went out.
      if (order.status === ORDER_STATUS.PAID && order.confirmationSentAt === null && order.trackingReference) {
        await this.sendPaidConfirmation(order, payment.id, order.trackingReference);
      }
      return { kind: 'duplicate', orderId: payment.orderId, paymentId: payment.id };
    }

    // Idempotent at the order level: never re-deduct or re-confirm an order
    // that already moved past payment (e.g. a refund raced this event).
    if (NO_REFUND_STATUSES.includes(order.status)) {
      logger.info('charge.success ignored — order already progressed', { orderId: order.id, status: order.status });
      return { kind: 'duplicate', orderId: order.id, paymentId: payment.id };
    }

    let trackingReference: string;
    try {
      trackingReference = await prisma.$transaction(async (tx) => {
        for (const item of order.items) {
          const deducted = await tx.stockLevel.updateMany({
            where: { productId: item.productId, quantity: { gte: item.quantity } },
            data: { quantity: { decrement: item.quantity } },
          });
          if (deducted.count === 0) {
            throw new StockRaceError({ productId: item.productId, requested: item.quantity, orderId: order.id });
          }
        }
        const tracking = generateTrackingReference();
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: ORDER_STATUS.PAID,
            paidAt: new Date(),
            deliveryStatus: DELIVERY_STATUS.PROCESSING,
            trackingReference: tracking,
          },
        });
        return tracking;
      });
    } catch (err) {
      if (err instanceof StockRaceError) {
        await this.handleStockRace(order.businessId, order.id, payment.id, err.details);
        return { kind: 'rejected', reason: 'stock_race' };
      }
      throw err;
    }

    // Audits run after commit — the audit writer must not be inside the tx.
    await audit.record({
      businessId: order.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.PAYMENT_CONFIRMED,
      entityType: 'PAYMENT',
      entityId: payment.id,
      details: {
        orderId: order.id,
        reference: data.reference,
        amount: Number(payment.amount),
        currency: payment.currency,
        trackingReference,
      },
    });
    await audit.record({
      businessId: order.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.STOCK_DEDUCTED,
      entityType: 'ORDER',
      entityId: order.id,
      details: { items: order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
    });

    await this.sendPaidConfirmation(order, payment.id, trackingReference);

    logger.info('payment confirmed and order marked paid', { orderId: order.id, paymentId: payment.id, trackingReference });
    return { kind: 'paid', orderId: order.id, paymentId: payment.id, trackingReference };
  }

  private async handleChargeFailed(data: PaystackChargeData): Promise<PaymentEventOutcome> {
    const { prisma, audit, logger } = this.deps;
    const payment = await prisma.payment.findUnique({ where: { reference: data.reference } });
    if (!payment) {
      logger.warn('paystack charge.failed for unknown reference', { reference: data.reference });
      return { kind: 'ignored', reason: 'unknown_reference' };
    }
    if (payment.status === PAYMENT_STATUS.SUCCESS) {
      // A late failed event must not un-confirm a completed payment.
      logger.warn('charge.failed ignored — payment already succeeded', { reference: data.reference, orderId: payment.orderId });
      return { kind: 'ignored', reason: 'already_success' };
    }

    const claimed = await prisma.payment.updateMany({
      where: { id: payment.id, status: PAYMENT_STATUS.PENDING },
      data: { status: PAYMENT_STATUS.FAILED, providerPayload: { data } as Prisma.InputJsonValue },
    });
    if (claimed.count === 0) {
      return { kind: 'duplicate', orderId: payment.orderId, paymentId: payment.id };
    }

    // Order stays PAYMENT_PENDING — the follow-up engine nudges the customer
    // with a fresh payment link, so nothing else to change here.
    await audit.record({
      businessId: 'unknown',
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.PAYMENT_FAILED,
      entityType: 'PAYMENT',
      entityId: payment.id,
      details: {
        orderId: payment.orderId,
        reference: data.reference,
        gatewayResponse: data.gateway_response ?? null,
        status: data.status ?? null,
      },
    });

    logger.info('payment failed', { reference: data.reference, orderId: payment.orderId });
    return { kind: 'failed', orderId: payment.orderId, paymentId: payment.id };
  }

  /**
   * Two customers paid for the same last unit: the atomic conditional stock
   * update lost for this order. Money was taken, so this MUST be surfaced to
   * a human for a refund — the order is cancelled and loudly audited.
   */
  private async handleStockRace(
    businessId: string,
    orderId: string,
    paymentId: string,
    details: { productId: string; requested: number },
  ): Promise<void> {
    const { prisma, audit, logger } = this.deps;
    // Money was taken — the cancel is not best-effort. Retry transient DB
    // failures; if it still fails, surface loudly and fail the job instead of
    // silently leaving a charged-but-live order.
    try {
      await withRetry(
        () => prisma.order.update({ where: { id: orderId }, data: { status: ORDER_STATUS.CANCELLED } }),
        { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000, logger },
      );
    } catch (err) {
      logger.error('STOCK RACE — FAILED to cancel order, manual refund REQUIRED', {
        orderId,
        paymentId,
        ...details,
        error: messageFromError(err),
      });
      throw err;
    }
    await audit.record({
      businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.STOCK_RACE_CONFLICT,
      entityType: 'ORDER',
      entityId: orderId,
      details: { paymentId, ...details, note: 'REQUIRES MANUAL REFUND' },
    });
    logger.error('STOCK RACE — order cancelled, manual refund required', { orderId, paymentId, ...details });
  }

  /**
   * Sends the "paid + tracking" confirmation exactly once. The claim on
   * `confirmationSentAt` is atomic; if the WhatsApp call fails the flag is
   * reset and the error rethrown so BullMQ retries and re-sends.
   */
  private async sendPaidConfirmation(
    order: {
      id: string;
      businessId: string;
      total: Prisma.Decimal | null;
      currency: string;
      customer: { id: string; waId: string; name: string | null; profileName: string | null };
      business: { name: string };
      items: Array<{ product: { name: string }; quantity: number; unitPrice: Prisma.Decimal }>;
    },
    paymentId: string,
    trackingReference: string,
  ): Promise<void> {
    const { prisma, whatsapp, audit, logger } = this.deps;

    const claimed = await prisma.order.updateMany({
      where: { id: order.id, status: ORDER_STATUS.PAID, confirmationSentAt: null },
      data: { confirmationSentAt: new Date() },
    });
    if (claimed.count === 0) {
      logger.info('confirmation already sent for order', { orderId: order.id });
      return;
    }

    const message = buildPaidConfirmation({
      businessName: order.business.name,
      customerName: order.customer.name ?? order.customer.profileName,
      items: order.items.map((i) => ({ productName: i.product.name, quantity: i.quantity, unitPrice: Number(i.unitPrice) })),
      total: Number(order.total ?? 0),
      currency: order.currency,
      trackingReference,
    });

    let sent;
    try {
      sent = await whatsapp.sendText(order.customer.waId, message);
    } catch (err) {
      // Release the claim so the retry re-sends (the order is paid either way).
      // The reset is itself money-critical: if it fails the retry would skip the
      // resend and the paid receipt would be lost — retry it, and if that fails
      // log loudly that the receipt may be lost.
      try {
        await withRetry(
          () =>
            prisma.order.updateMany({
              where: { id: order.id, confirmationSentAt: { not: null } },
              data: { confirmationSentAt: null },
            }),
          { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000, logger },
        );
      } catch (resetErr) {
        logger.error('paid confirmation send failed AND claim release failed — receipt may be lost', {
          orderId: order.id,
          paymentId,
          sendError: messageFromError(err),
          resetError: messageFromError(resetErr),
        });
      }
      logger.error('paid confirmation send failed', { orderId: order.id, paymentId, error: messageFromError(err) });
      throw err;
    }

    const conversation = await prisma.conversation.findFirst({
      where: { businessId: order.businessId, customerId: order.customer.id, status: CONVERSATION_STATUS.OPEN },
      orderBy: { updatedAt: 'desc' },
    });
    if (conversation) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MESSAGE_DIRECTION.OUTBOUND,
          waMessageId: sent.waMessageId ?? null,
          type: 'text',
          text: message,
          status: MESSAGE_STATUS.SENT,
          sentAt: new Date(),
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    await audit.record({
      businessId: order.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.PAYMENT_CONFIRMATION_SENT,
      entityType: 'ORDER',
      entityId: order.id,
      details: { paymentId, trackingReference, waMessageId: sent.waMessageId ?? null },
    });
  }

  private async claimFailed(paymentId: string, data: PaystackChargeData, reason: string): Promise<void> {
    await this.deps.prisma.payment.updateMany({
      where: { id: paymentId, status: { not: PAYMENT_STATUS.SUCCESS } },
      data: { status: PAYMENT_STATUS.FAILED, providerPayload: { data, reason } as Prisma.InputJsonValue },
    });
  }
}

export class StockRaceError extends Error {
  constructor(public readonly details: { productId: string; requested: number; orderId: string }) {
    super('insufficient stock at payment confirmation');
    this.name = 'StockRaceError';
  }
}

export function createPaymentService(deps: PaymentServiceDeps): PaymentService {
  return new PaymentService(deps);
}