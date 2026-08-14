import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../packages/db/src';
import { createLogger, AUDIT_ACTIONS, ORDER_STATUS, PAYMENT_STATUS } from '../../packages/shared/src';
import { createAuditService, type AuditService } from '../../packages/audit/src';
import { createPaymentService, type PaymentService } from '../../packages/payment/src';
import type { WhatsAppClient } from '../../packages/whatsapp/src';

/**
 * Phase 7 integration tests against real Postgres (Testcontainers, CI only):
 *   - a charge.success is exactly-once: payment SUCCESS, order PAID, stock
 *     deducted, tracking reference assigned, confirmation message sent
 *   - a duplicate webhook delivery never double-deducts or double-confirms
 *   - a charge.failed leaves the order payable for a follow-up nudge
 *   - two customers paying for the last unit concurrently: exactly one order is
 *     PAID, stock never goes negative, the loser is CANCELLED + audited
 */

let prisma: PrismaClient;
let audit: AuditService;
let paymentService: PaymentService;
let whatsapp: { sendText: ReturnType<typeof import('vitest').vi.fn> };

const logger = createLogger('payments-integration');
const PNID = 'PAY_PNID';
const WA_ID = `2348${String(Date.now()).slice(-9)}`;
const sentTexts: string[] = [];

const seed = {
  businessId: '',
  customerId: '',
  conversationId: '',
  productId: '',
};

beforeAll(async () => {
  prisma = createPrismaClient();
  audit = createAuditService({ prisma, logger });
  whatsapp = {
    sendText: vi.fn(async (to: string, body: string) => {
      sentTexts.push(body);
      return { waMessageId: `wamid.${to}.${sentTexts.length}` };
    }),
  };
  paymentService = createPaymentService({
    prisma,
    whatsapp: whatsapp as unknown as WhatsAppClient,
    audit,
    logger,
  });

  await prisma.payment.deleteMany({ where: { order: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.stockLevel.deleteMany({ where: { product: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.customer.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);

  const business = await prisma.business.create({ data: { name: 'Payments Shop', phoneNumber: PNID, currency: 'NGN' } });
  const customer = await prisma.customer.create({ data: { businessId: business.id, waId: WA_ID, name: 'Payments Tester' } });
  const conversation = await prisma.conversation.create({ data: { businessId: business.id, customerId: customer.id, status: 'OPEN' } });
  const product = await prisma.product.create({
    data: {
      id: 'pay-product-rice',
      name: 'Royal Stallion Rice 50kg',
      sku: 'SKU-PAY-RICE',
      price: 85000,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
      stockLevels: { create: { quantity: 40, reserved: 0 } },
    },
  });

  seed.businessId = business.id;
  seed.customerId = customer.id;
  seed.conversationId = conversation.id;
  seed.productId = product.id;
});

afterAll(async () => {
  await prisma?.$disconnect();
});

/** Seeds a fresh PAYMENT_PENDING order for the shared customer + product. */
async function seedOrder(id: string, quantity: number): Promise<{ orderId: string; paymentId: string; reference: string }> {
  const order = await prisma.order.create({
    data: {
      id,
      businessId: seed.businessId,
      customerId: seed.customerId,
      status: ORDER_STATUS.PAYMENT_PENDING,
      subtotal: 85000 * quantity,
      total: 85000 * quantity,
      currency: 'NGN',
      items: {
        create: [{ productId: seed.productId, quantity, unitPrice: 85000, total: 85000 * quantity }],
      },
      payments: {
        create: [{ provider: 'PAYSTACK', reference: `REF-${id}`, amount: 85000 * quantity, currency: 'NGN', status: PAYMENT_STATUS.PENDING }],
      },
    },
    include: { payments: true },
  });
  return { orderId: order.id, paymentId: order.payments[0].id, reference: order.payments[0].reference };
}

describe('payments integration — real Postgres', () => {
  it('confirms a charge.success exactly once (stock deducted, tracking assigned, confirmation sent)', async () => {
    const { orderId, paymentId, reference } = await seedOrder('pay-order-success', 2);
    const amountKobo = 85000 * 2 * 100;

    const outcome = await paymentService.handleChargeEvent({ event: 'charge.success', data: { reference, amount: amountKobo } });

    expect(outcome.kind).toBe('paid');

    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    expect(order!.status).toBe(ORDER_STATUS.PAID);
    expect(order!.deliveryStatus).toBe('PROCESSING');
    expect(order!.trackingReference).toMatch(/^TRK-/);
    expect(order!.paidAt).not.toBeNull();
    expect(order!.payments[0].status).toBe(PAYMENT_STATUS.SUCCESS);

    const stock = await prisma.stockLevel.findUnique({ where: { productId: seed.productId } });
    expect(stock!.quantity).toBe(38);

    const auditRow = await prisma.agentAction.findFirst({ where: { entityId: paymentId, action: AUDIT_ACTIONS.PAYMENT_CONFIRMED } });
    expect(auditRow).not.toBeNull();
    expect(sentTexts.some((t) => t.includes(order!.trackingReference!))).toBe(true);
  });

  it('ignores a duplicate charge.success delivery (no double deduct, one confirmation)', async () => {
    const { reference } = await seedOrder('pay-order-duplicate', 1);
    const amountKobo = 85000 * 100;

    const first = await paymentService.handleChargeEvent({ event: 'charge.success', data: { reference, amount: amountKobo } });
    const before = await prisma.stockLevel.findUnique({ where: { productId: seed.productId } });
    const textsBefore = sentTexts.length;

    const second = await paymentService.handleChargeEvent({ event: 'charge.success', data: { reference, amount: amountKobo } });

    expect(first.kind).toBe('paid');
    expect(second.kind).toBe('duplicate');
    const after = await prisma.stockLevel.findUnique({ where: { productId: seed.productId } });
    expect(after!.quantity).toBe(before!.quantity); // not double-deducted
    expect(sentTexts.length).toBe(textsBefore + 0); // no second confirmation
  });

  it('marks a failed payment and leaves the order payable for a follow-up nudge', async () => {
    const { orderId, paymentId, reference } = await seedOrder('pay-order-failed', 1);

    const outcome = await paymentService.handleChargeEvent({ event: 'charge.failed', data: { reference, status: 'failed' } });

    expect(outcome.kind).toBe('failed');
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
    expect(order!.status).toBe(ORDER_STATUS.PAYMENT_PENDING); // still nudgeable
    expect(order!.payments[0].status).toBe(PAYMENT_STATUS.FAILED);
    const auditRow = await prisma.agentAction.findFirst({ where: { entityId: paymentId, action: AUDIT_ACTIONS.PAYMENT_FAILED } });
    expect(auditRow).not.toBeNull();
  });

  it('stock race: two customers pay for the last unit — exactly one wins, stock never negative', async () => {
    // Crank stock down to a single unit.
    await prisma.stockLevel.update({ where: { productId: seed.productId }, data: { quantity: 1 } });

    const a = await seedOrder('pay-order-race-a', 1);
    const b = await seedOrder('pay-order-race-b', 1);
    const amountKobo = 85000 * 100;

    const [ra, rb] = await Promise.all([
      paymentService.handleChargeEvent({ event: 'charge.success', data: { reference: a.reference, amount: amountKobo } }),
      paymentService.handleChargeEvent({ event: 'charge.success', data: { reference: b.reference, amount: amountKobo } }),
    ]);

    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(['paid', 'rejected']);
    const loserRef = ra.kind === 'rejected' ? a.reference : b.reference;
    const winnerRef = ra.kind === 'paid' ? a.reference : b.reference;

    const winner = await prisma.payment.findUnique({ where: { reference: winnerRef }, include: { order: true } });
    const loser = await prisma.payment.findUnique({ where: { reference: loserRef }, include: { order: true } });
    expect(winner!.order.status).toBe(ORDER_STATUS.PAID);
    expect(loser!.order.status).toBe(ORDER_STATUS.CANCELLED);

    const stock = await prisma.stockLevel.findUnique({ where: { productId: seed.productId } });
    expect(stock!.quantity).toBe(0); // never negative

    const raceAudit = await prisma.agentAction.findFirst({ where: { entityId: loser!.orderId, action: AUDIT_ACTIONS.STOCK_RACE_CONFLICT } });
    expect(raceAudit).not.toBeNull();
    expect(raceAudit!.details).toMatchObject({ note: 'REQUIRES MANUAL REFUND' });

    // Restore stock for any later runs.
    await prisma.stockLevel.update({ where: { productId: seed.productId }, data: { quantity: 40 } });
  });
});