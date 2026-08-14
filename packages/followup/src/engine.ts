import { Prisma, type PrismaClient } from '../../db/src';
import type { AppLogger } from '../../shared/src';
import type { AuditService } from '../../audit/src';
import type { WhatsAppClient } from '../../whatsapp/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  CONVERSATION_STATUS,
  FOLLOWUP_STATUS,
  FOLLOWUP_TYPE,
  MESSAGE_DIRECTION,
  MESSAGE_STATUS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  isUniqueConstraintError,
  messageFromError,
} from '../../shared/src';
import { decideFollowUp, isQuietHour, type FollowUpConfig, type DueDecision } from './timing';
import { buildFollowUpMessage, buildPaymentFollowUpMessage, type FollowUpCartItem } from './message';

export interface FollowUpServiceDeps {
  prisma: PrismaClient;
  whatsapp: WhatsAppClient;
  audit: AuditService;
  logger: AppLogger;
  config: FollowUpConfig;
}

export interface FollowUpScanSummary {
  scanned: number;
  sent: number;
  skippedNoCart: number;
  skippedNotDue: number;
  skippedCapped: number;
  skippedQuietHours: number;
  // Phase 7 — abandoned-payment pass (order created, payment never completed).
  scannedPayments: number;
  sentPayments: number;
  skippedPaymentNotDue: number;
  skippedPaymentCapped: number;
  skippedPaymentQuietHours: number;
}

export interface FollowUpItemRecord {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

/**
 * Background abandoned-cart (CART) and abandoned-payment (PAYMENT) follow-up
 * engine (Phase 5 + Phase 7).
 *
 * Runs as a BullMQ repeatable job (never in the webhook path). For each OPEN
 * conversation with a non-empty cart that has gone quiet, and for each OPEN
 * conversation whose order is stuck on PAYMENT_PENDING with an uncompleted
 * payment:
 *   - decides due / capped / not-yet via `decideFollowUp` (clock injected)
 *   - respects quiet hours in the business's local timezone
 *   - claims a `follow_ups` row (unique [conversationId, type, attempt]) BEFORE
 *     sending, so two racing scans can never double-send
 *   - sends a message that names the exact items (or re-shares the payment
 *     link), records the message row, and audits FOLLOW_UP_SENT
 *
 * A WhatsApp send failure marks the claim FAILED (the attempt still counts
 * toward the cap) and rethrows so BullMQ retries the scan.
 */
export class FollowUpService {
  constructor(private readonly deps: FollowUpServiceDeps) {}

  async runScan(opts: { now?: Date } = {}): Promise<FollowUpScanSummary> {
    const now = opts.now ?? new Date();
    const summary: FollowUpScanSummary = {
      scanned: 0,
      sent: 0,
      skippedNoCart: 0,
      skippedNotDue: 0,
      skippedCapped: 0,
      skippedQuietHours: 0,
      scannedPayments: 0,
      sentPayments: 0,
      skippedPaymentNotDue: 0,
      skippedPaymentCapped: 0,
      skippedPaymentQuietHours: 0,
    };

    const conversations = await this.deps.prisma.conversation.findMany({
      where: {
        status: CONVERSATION_STATUS.OPEN,
        metadata: { path: ['cart'], not: Prisma.DbNull },
      },
      include: { business: true, customer: true },
    });

    const candidates = conversations.filter((c) => this.cartItems(c).length > 0);
    summary.scanned = candidates.length;

    if (candidates.length === 0) return summary;

    const ids = candidates.map((c) => c.id);
    const lastInbound = await this.lastInboundAt(ids);
    const attemptCounts = await this.attemptCounts(ids, FOLLOWUP_TYPE.CART);

    for (const conversation of candidates) {
      const lastActivityAt = lastInbound.get(conversation.id) ?? conversation.lastMessageAt ?? conversation.createdAt;
      const sentAttempts = attemptCounts.get(conversation.id) ?? 0;

      const outcome = await this.processConversation({ conversation, lastActivityAt, sentAttempts, now });

      if (outcome.kind === 'sent') {
        summary.sent += 1;
      } else if (outcome.kind === 'skipped') {
        switch (outcome.reason) {
          case 'not_due':
            summary.skippedNotDue += 1;
            break;
          case 'capped':
            summary.skippedCapped += 1;
            break;
          case 'quiet_hours':
            summary.skippedQuietHours += 1;
            break;
          case 'no_cart':
            summary.skippedNoCart += 1;
            break;
          // 'already_claimed' is a benign race — do not count it as work.
        }
      }
    }

    await this.runPaymentPass({ summary, now });

    return summary;
  }

  /**
   * Phase 7 — abandoned-payment nudges. For every OPEN conversation whose
   * customer has an order stuck on PAYMENT_PENDING with an uncompleted payment,
   * apply the same due/quiet/cap rules and send a message that re-shares the
   * payment link. Claims are `[conversationId, PAYMENT, attempt]`-unique, so
   * racing scans can never double-send a payment nudge.
   */
  private async runPaymentPass(args: { summary: FollowUpScanSummary; now: Date }): Promise<void> {
    const { summary, now } = args;

    const conversations = await this.deps.prisma.conversation.findMany({
      where: {
        status: CONVERSATION_STATUS.OPEN,
        customer: {
          orders: {
            some: {
              status: ORDER_STATUS.PAYMENT_PENDING,
              payments: { some: { status: PAYMENT_STATUS.PENDING } },
            },
          },
        },
      },
      include: {
        business: true,
        customer: {
          include: {
            orders: {
              where: {
                status: ORDER_STATUS.PAYMENT_PENDING,
                payments: { some: { status: PAYMENT_STATUS.PENDING } },
              },
              include: { payments: true, items: { include: { product: true } } },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    summary.scannedPayments = conversations.length;
    if (conversations.length === 0) return;

    const ids = conversations.map((c) => c.id);
    const lastInbound = await this.lastInboundAt(ids);
    const attemptCounts = await this.attemptCounts(ids, FOLLOWUP_TYPE.PAYMENT);

    for (const conversation of conversations) {
      const order = conversation.customer.orders?.[0];
      if (!order) continue;
      const payment = order.payments?.[0];
      if (!payment) continue;

      const paymentUrl = this.paymentUrlOf(payment);
      const lastActivityAt = lastInbound.get(conversation.id) ?? conversation.lastMessageAt ?? conversation.createdAt;
      const sentAttempts = attemptCounts.get(conversation.id) ?? 0;

      const outcome = await this.processPaymentConversation({
        conversation: conversation as never,
        order,
        paymentUrl,
        lastActivityAt,
        sentAttempts,
        now,
      });

      if (outcome.kind === 'sent') {
        summary.sentPayments += 1;
      } else if (outcome.kind === 'skipped') {
        if (outcome.reason === 'not_due') summary.skippedPaymentNotDue += 1;
        else if (outcome.reason === 'capped') summary.skippedPaymentCapped += 1;
        else if (outcome.reason === 'quiet_hours') summary.skippedPaymentQuietHours += 1;
      }
    }
  }

  private async processPaymentConversation(args: {
    conversation: {
      id: string;
      businessId: string;
      customerId: string;
      lastMessageAt: Date | null;
      createdAt: Date;
      business: { name: string; timezone: string; currency: string };
      customer: { name: string | null; profileName: string | null; waId: string };
    };
    order: { id: string; total: Prisma.Decimal | null; items: Array<{ productId: string; product: { name: string } | null; quantity: number; unitPrice: Prisma.Decimal }> };
    paymentUrl: string;
    lastActivityAt: Date;
    sentAttempts: number;
    now: Date;
  }): Promise<{ kind: 'sent'; followUpId: string; attempt: number } | { kind: 'skipped'; reason: string }> {
    const { conversation, order, paymentUrl, lastActivityAt, sentAttempts, now } = args;
    const loggerCtx = { conversationId: conversation.id, orderId: order.id, sentAttempts };

    // Never send a payment nudge without a working link — an empty URL in the
    // customer's message is worse than no message at all.
    if (!paymentUrl) {
      this.deps.logger.warn('payment follow-up skipped — no payment link available', loggerCtx);
      return { kind: 'skipped', reason: 'no_payment_url' };
    }

    const decision: DueDecision = decideFollowUp(now, lastActivityAt, sentAttempts, this.deps.config);
    if (decision.kind === 'capped') return { kind: 'skipped', reason: 'capped' };
    if (decision.kind === 'not_due') return { kind: 'skipped', reason: 'not_due' };

    const quiet = isQuietHour(now, conversation.business.timezone, this.deps.config);
    if (quiet) {
      this.deps.logger.info('payment follow-up skipped — quiet hours', { ...loggerCtx, timezone: conversation.business.timezone });
      return { kind: 'skipped', reason: 'quiet_hours' };
    }

    const attempt = decision.attempt;
    const items: FollowUpCartItem[] = order.items.map((i) => ({
      productId: i.productId,
      productName: i.product?.name ?? 'item',
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
    }));
    const message = buildPaymentFollowUpMessage({
      businessName: conversation.business.name,
      customerName: conversation.customer.name ?? conversation.customer.profileName,
      orderId: order.id,
      total: Number(order.total ?? 0),
      currency: conversation.business.currency,
      paymentUrl,
      attempt,
    });

    let claim;
    try {
      claim = await this.deps.prisma.followUp.create({
        data: {
          businessId: conversation.businessId,
          customerId: conversation.customerId,
          conversationId: conversation.id,
          type: FOLLOWUP_TYPE.PAYMENT,
          attempt,
          items: items as unknown as Prisma.InputJsonValue,
          messageText: message,
          status: FOLLOWUP_STATUS.SENDING,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        this.deps.logger.warn('payment follow-up attempt already claimed — skipping', { ...loggerCtx, attempt });
        return { kind: 'skipped', reason: 'already_claimed' };
      }
      throw err;
    }

    let sent;
    try {
      sent = await this.deps.whatsapp.sendText(conversation.customer.waId, message);
    } catch (err) {
      await this.deps.prisma.followUp
        .update({ where: { id: claim.id }, data: { status: FOLLOWUP_STATUS.FAILED } })
        .catch(() => undefined);
      this.deps.logger.error('payment follow-up send failed', { ...loggerCtx, attempt, error: messageFromError(err) });
      throw err;
    }

    await this.deps.prisma.followUp.update({
      where: { id: claim.id },
      data: { status: FOLLOWUP_STATUS.SENT, waMessageId: sent.waMessageId ?? null },
    });
    await this.deps.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MESSAGE_DIRECTION.OUTBOUND,
        waMessageId: sent.waMessageId ?? null,
        type: 'text',
        text: message,
        status: MESSAGE_STATUS.SENT,
        sentAt: now,
      },
    });
    await this.deps.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now },
    });

    await this.deps.audit.record({
      businessId: conversation.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.FOLLOW_UP_SENT,
      entityType: 'FOLLOW_UP',
      entityId: claim.id,
      details: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        type: FOLLOWUP_TYPE.PAYMENT,
        orderId: order.id,
        attempt,
        items,
        paymentUrl,
        message,
        waMessageId: sent.waMessageId ?? null,
      },
    });

    this.deps.logger.info('payment follow-up sent', { ...loggerCtx, attempt, waMessageId: sent.waMessageId });
    return { kind: 'sent', followUpId: claim.id, attempt };
  }

  private paymentUrlOf(payment: { providerPayload: unknown }): string {
    const payload = payment.providerPayload as { authorizationUrl?: string } | null;
    return typeof payload?.authorizationUrl === 'string' ? payload.authorizationUrl : '';
  }

  private async processConversation(args: {
    conversation: {
      id: string;
      businessId: string;
      customerId: string;
      lastMessageAt: Date | null;
      createdAt: Date;
      metadata: unknown;
      business: { name: string; timezone: string; currency: string };
      customer: { name: string | null; profileName: string | null; waId: string };
    };
    lastActivityAt: Date;
    sentAttempts: number;
    now: Date;
  }): Promise<{ kind: 'sent'; followUpId: string; attempt: number; message: string; waMessageId: string } | { kind: 'skipped'; reason: string }> {
    const { conversation, lastActivityAt, sentAttempts, now } = args;
    const loggerCtx = { conversationId: conversation.id, sentAttempts };

    const items = this.cartItems(conversation);
    if (items.length === 0) return { kind: 'skipped', reason: 'no_cart' };

    const decision: DueDecision = decideFollowUp(now, lastActivityAt, sentAttempts, this.deps.config);
    if (decision.kind === 'capped') return { kind: 'skipped', reason: 'capped' };
    if (decision.kind === 'not_due') return { kind: 'skipped', reason: 'not_due' };

    const quiet = isQuietHour(now, conversation.business.timezone, this.deps.config);
    if (quiet) {
      this.deps.logger.info('follow-up skipped — quiet hours', { ...loggerCtx, timezone: conversation.business.timezone });
      return { kind: 'skipped', reason: 'quiet_hours' };
    }

    const attempt = decision.attempt;
    const message = buildFollowUpMessage({
      businessName: conversation.business.name,
      customerName: conversation.customer.name ?? conversation.customer.profileName,
      items,
      attempt,
      currency: conversation.business.currency,
    });

    // Claim the attempt BEFORE sending. `[conversationId, type, attempt]` is
    // unique, so a concurrent scan that computes the same attempt loses the
    // race here instead of double-sending.
    let claim;
    try {
      claim = await this.deps.prisma.followUp.create({
        data: {
          businessId: conversation.businessId,
          customerId: conversation.customerId,
          conversationId: conversation.id,
          type: FOLLOWUP_TYPE.CART,
          attempt,
          items: items as unknown as Prisma.InputJsonValue,
          messageText: message,
          status: FOLLOWUP_STATUS.SENDING,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        this.deps.logger.warn('follow-up attempt already claimed — skipping', { ...loggerCtx, attempt });
        return { kind: 'skipped', reason: 'already_claimed' };
      }
      throw err;
    }

    let sent;
    try {
      sent = await this.deps.whatsapp.sendText(conversation.customer.waId, message);
    } catch (err) {
      // The attempt still consumed its slot (cap stays honest). Rethrow so
      // BullMQ retries the scan and we re-send as the next attempt.
      await this.deps.prisma.followUp
        .update({ where: { id: claim.id }, data: { status: FOLLOWUP_STATUS.FAILED } })
        .catch(() => undefined);
      this.deps.logger.error('follow-up send failed', { ...loggerCtx, attempt, error: messageFromError(err) });
      throw err;
    }

    await this.deps.prisma.followUp.update({
      where: { id: claim.id },
      data: { status: FOLLOWUP_STATUS.SENT, waMessageId: sent.waMessageId ?? null },
    });

    // Persist as a real outbound message so the agent's history and the
    // conversation timeline stay coherent (and audits don't lose it).
    await this.deps.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MESSAGE_DIRECTION.OUTBOUND,
        waMessageId: sent.waMessageId ?? null,
        type: 'text',
        text: message,
        status: MESSAGE_STATUS.SENT,
        sentAt: now,
      },
    });
    await this.deps.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: now },
    });

    await this.deps.audit.record({
      businessId: conversation.businessId,
      actorType: AUDIT_ACTOR.SYSTEM,
      action: AUDIT_ACTIONS.FOLLOW_UP_SENT,
      entityType: 'FOLLOW_UP',
      entityId: claim.id,
      details: {
        conversationId: conversation.id,
        customerId: conversation.customerId,
        attempt,
        items,
        message,
        waMessageId: sent.waMessageId ?? null,
      },
    });

    this.deps.logger.info('follow-up sent', { ...loggerCtx, attempt, waMessageId: sent.waMessageId });

    return { kind: 'sent', followUpId: claim.id, attempt, message, waMessageId: sent.waMessageId ?? '' };
  }

  /** Reads the persisted cart items from conversation metadata, safely. */
  private cartItems(conversation: { metadata: unknown }): FollowUpCartItem[] {
    const meta = conversation.metadata as { cart?: { items?: unknown } } | null;
    const raw = meta?.cart?.items;
    if (!Array.isArray(raw)) return [];
    const items: FollowUpCartItem[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const productName = String(item.productName ?? '').trim();
      if (!productName) continue;
      items.push({
        productId: String(item.productId ?? ''),
        productName,
        quantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        unitPrice: Number(item.unitPrice) || 0,
      });
    }
    return items;
  }

  /** Latest inbound message time per conversation (single query). */
  private async lastInboundAt(conversationIds: string[]): Promise<Map<string, Date>> {
    const messages = await this.deps.prisma.message.findMany({
      where: { conversationId: { in: conversationIds }, direction: MESSAGE_DIRECTION.INBOUND },
      orderBy: { sentAt: 'desc' },
      select: { conversationId: true, sentAt: true },
    });
    const map = new Map<string, Date>();
    for (const m of messages) {
      if (!map.has(m.conversationId)) map.set(m.conversationId, m.sentAt);
    }
    return map;
  }

  /** Follow-up attempt count per conversation for ONE type (any status — keeps the cap honest). */
  private async attemptCounts(conversationIds: string[], type: string): Promise<Map<string, number>> {
    const grouped = await this.deps.prisma.followUp.groupBy({
      by: ['conversationId'],
      where: { conversationId: { in: conversationIds }, type },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.conversationId, g._count._all]));
  }
}

export function createFollowUpService(deps: FollowUpServiceDeps): FollowUpService {
  return new FollowUpService(deps);
}