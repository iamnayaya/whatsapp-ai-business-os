import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../packages/db/src';
import { ESCALATION_CATEGORY, ESCALATION_STATUS, FOLLOWUP_STATUS, FOLLOWUP_TYPE, ORDER_STATUS } from '../../packages/shared/src';
import { createAnalyticsService, type AnalyticsService } from '../../packages/analytics/src';

/**
 * Phase 8 integration tests against real Postgres (Testcontainers, CI only):
 * the raw aggregation SQL must produce correct sales buckets, conversion,
 * follow-up recovery, escalation volume, and recent-conversation sentiment.
 * A fixed `now` is passed so the timezone-bucketed boundaries are exact.
 */

const PNID = 'ANALYTICS_PNID';
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14T12:00:00Z (13:00 in Lagos)
const at = (msAgo: number) => new Date(NOW - msAgo);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let prisma: PrismaClient;
let analytics: AnalyticsService;

const ids = {
  business: '',
  product: '',
  convA: '',
  convB: '',
  convC: '',
  convD: '',
  convE: '',
};

beforeAll(async () => {
  prisma = createPrismaClient();

  await prisma.message.deleteMany({ where: { conversation: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.followUp.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.escalation.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.payment.deleteMany({ where: { order: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.stockLevel.deleteMany({ where: { product: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.customer.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);

  const business = await prisma.business.create({
    data: { name: 'Analytics Shop', phoneNumber: PNID, currency: 'NGN', timezone: 'Africa/Lagos' },
  });
  ids.business = business.id;

  const product = await prisma.product.create({
    data: {
      id: 'an-product-rice',
      name: 'Royal Stallion Rice 50kg',
      sku: 'SKU-AN-RICE',
      price: 50000,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
      stockLevels: { create: { quantity: 100, reserved: 0 } },
    },
  });
  ids.product = product.id;

  const customer = async (waId: string, name: string) =>
    prisma.customer.create({ data: { businessId: business.id, waId, name } });

  const [custA, custB, custC, custD, custE] = await Promise.all([
    customer('2348100000001', 'Amina'),
    customer('2348100000002', 'Bello'),
    customer('2348100000003', 'Chioma'),
    customer('2348100000004', 'Danladi'),
    customer('2348100000005', 'Efe'),
  ]);

  const conv = async (customerId: string, createdAt: Date, lastMessageAt: Date) =>
    prisma.conversation.create({
      data: { businessId: business.id, customerId, status: 'OPEN', createdAt, lastMessageAt },
    });

  // ConvA–D started this month; convE started 45 days ago (outside every bucket).
  const convA = await conv(custA.id, at(1 * DAY), at(1 * DAY - HOUR));
  const convB = await conv(custB.id, at(2 * DAY), at(2 * DAY));
  const convC = await conv(custC.id, at(3 * DAY), at(1 * HOUR));
  const convD = await conv(custD.id, at(3 * DAY), at(2 * HOUR));
  const convE = await conv(custE.id, at(45 * DAY), at(45 * DAY));
  ids.convA = convA.id;
  ids.convB = convB.id;
  ids.convC = convC.id;
  ids.convD = convD.id;
  ids.convE = convE.id;

  const order = async (id: string, customerId: string, total: number, paidAt: Date | null, createdAt: Date) =>
    prisma.order.create({
      data: {
        id,
        businessId: business.id,
        customerId,
        status: paidAt ? ORDER_STATUS.PAID : ORDER_STATUS.DRAFT,
        subtotal: total,
        total,
        currency: 'NGN',
        paidAt,
        createdAt,
        items: {
          create: [{ productId: product.id, quantity: 1, unitPrice: total, total }],
        },
      },
    });

  // Sales buckets: today / this week / this month / outside-month / draft.
  await order('an-order-today', custA.id, 50000, at(1 * HOUR), at(1 * DAY));
  await order('an-order-week', custB.id, 75000, at(2 * DAY), at(2 * DAY));
  await order('an-order-month', custC.id, 60000, at(7 * DAY), at(7 * DAY));
  await order('an-order-out', custE.id, 90000, at(40 * DAY), at(40 * DAY));
  await order('an-order-draft', custD.id, 1000, null, at(1 * DAY));

  // Follow-ups: CART 2/3 recovered, PAYMENT 0/1, one SENDING (excluded).
  const followUp = async (conversationId: string, customerId: string, type: string, attempt: number, status: string, ledToOrder: boolean) =>
    prisma.followUp.create({
      data: {
        businessId: business.id,
        customerId,
        conversationId,
        type,
        attempt,
        items: [],
        messageText: 'nudge',
        status,
        ledToOrder,
      },
    });
  await followUp(convA.id, custA.id, FOLLOWUP_TYPE.CART, 1, FOLLOWUP_STATUS.SENT, true);
  await followUp(convB.id, custB.id, FOLLOWUP_TYPE.CART, 1, FOLLOWUP_STATUS.SENT, false);
  await followUp(convC.id, custC.id, FOLLOWUP_TYPE.CART, 1, FOLLOWUP_STATUS.SENT, true);
  await followUp(convD.id, custD.id, FOLLOWUP_TYPE.PAYMENT, 1, FOLLOWUP_STATUS.SENT, false);
  await followUp(convE.id, custE.id, FOLLOWUP_TYPE.CART, 1, FOLLOWUP_STATUS.SENDING, false);

  // Escalations: 5 this month (2 OPEN, 2 angry, 1 refund), 1 outside the month.
  const escalation = async (conversationId: string, customerId: string, category: string, status: string, createdAt: Date) =>
    prisma.escalation.create({
      data: {
        businessId: business.id,
        customerId,
        conversationId,
        reason: `reason for ${conversationId}`,
        category,
        sourceAgent: 'support',
        status,
        createdAt,
      },
    });
  await escalation(convA.id, custA.id, ESCALATION_CATEGORY.ANGRY_CUSTOMER, ESCALATION_STATUS.OPEN, at(1 * DAY));
  await escalation(convB.id, custB.id, ESCALATION_CATEGORY.REFUND_REQUEST, ESCALATION_STATUS.OPEN, at(1 * DAY));
  await escalation(convC.id, custC.id, ESCALATION_CATEGORY.ANGRY_CUSTOMER, ESCALATION_STATUS.RESOLVED, at(2 * DAY));
  await escalation(convD.id, custD.id, ESCALATION_CATEGORY.OTHER, ESCALATION_STATUS.RESOLVED, at(2 * DAY));
  await escalation(convE.id, custE.id, ESCALATION_CATEGORY.OTHER, ESCALATION_STATUS.RESOLVED, at(3 * DAY));
  await escalation(convD.id, custD.id, ESCALATION_CATEGORY.ANGRY_CUSTOMER, ESCALATION_STATUS.RESOLVED, at(40 * DAY));

  // Messages + the agent's own sentiment (Phase 8).
  const message = async (conversationId: string, direction: string, text: string | null, sentAt: Date, sentiment?: string) =>
    prisma.message.create({
      data: { conversationId, direction, type: 'text', text, sentAt, sentiment, status: 'SENT' },
    });
  await message(convA.id, 'INBOUND', 'Hello, do you sell rice?', at(1 * DAY));
  await message(convA.id, 'OUTBOUND', 'Yes! 50kg is ₦50,000.', at(1 * DAY - HOUR), 'POSITIVE');
  await message(convB.id, 'INBOUND', 'Price please', at(2 * DAY));
  await message(convC.id, 'OUTBOUND', 'I have escalated this.', at(1 * HOUR), 'FRUSTRATED');
  await message(convD.id, 'OUTBOUND', 'Thanks for waiting.', at(2 * HOUR));
  await message(convE.id, 'INBOUND', 'old conversation', at(45 * DAY));

  analytics = createAnalyticsService({ prisma, timeZone: 'Africa/Lagos', businessId: business.id });
});

afterAll(async () => {
  await prisma?.$disconnect();
});

describe('analytics integration — real Postgres', () => {
  it('buckets paid sales by today / this week / this month in the business timezone', async () => {
    const data = await analytics.overview(NOW);
    expect(data.sales).toEqual([
      { label: 'today', revenue: 50000, orders: 1 },
      { label: 'week', revenue: 125000, orders: 2 },
      { label: 'month', revenue: 185000, orders: 3 },
    ]);
  });

  it('computes conversion from distinct chatted vs converted customers this month', async () => {
    const data = await analytics.overview(NOW);
    expect(data.conversion).toEqual({ chatted: 4, converted: 3, rate: 0.75 });
  });

  it('computes follow-up recovery per type and overall (SENDING excluded)', async () => {
    const data = await analytics.overview(NOW);
    expect(data.recovery).toEqual([
      { type: 'CART', sent: 3, recovered: 2, rate: 2 / 3 },
      { type: 'PAYMENT', sent: 1, recovered: 0, rate: 0 },
      { type: 'OVERALL', sent: 4, recovered: 2, rate: 0.5 },
    ]);
  });

  it('counts escalations this month (total / open / angry / refund) with a category breakdown', async () => {
    const data = await analytics.overview(NOW);
    expect(data.escalations.total).toBe(5);
    expect(data.escalations.open).toBe(2);
    expect(data.escalations.resolved).toBe(3);
    expect(data.escalations.angry).toBe(2);
    expect(data.escalations.refundRequests).toBe(1);
    expect(data.escalations.byCategory).toEqual({
      ANGRY_CUSTOMER: 2,
      REFUND_REQUEST: 1,
      OTHER: 2,
    });
  });

  it('aggregates top-selling products from paid order items', async () => {
    const data = await analytics.overview(NOW);
    expect(data.topProducts).toEqual([
      { productId: 'an-product-rice', name: 'Royal Stallion Rice 50kg', quantity: 3, revenue: 185000 },
    ]);
  });

  it('finds peak inbound hours in the business timezone (30-day window)', async () => {
    const data = await analytics.overview(NOW);
    // Both in-window inbound messages were sent at 13:00 Lagos time.
    expect(data.peakHours[0]).toEqual({ hour: 13, count: 2 });
  });

  it('reports recent conversations with the agent own-sentiment from the latest agent turn', async () => {
    const data = await analytics.overview(NOW);
    // Most recent first.
    expect(data.recentConversations[0].conversationId).toBe(ids.convC);
    expect(data.recentConversations[0].sentiment).toBe('FRUSTRATED');
    const convA = data.recentConversations.find((c) => c.conversationId === ids.convA);
    expect(convA).toMatchObject({ lastInbound: 'Hello, do you sell rice?', sentiment: 'POSITIVE' });
    const convD = data.recentConversations.find((c) => c.conversationId === ids.convD);
    expect(convD!.sentiment).toBeNull();
  });
});