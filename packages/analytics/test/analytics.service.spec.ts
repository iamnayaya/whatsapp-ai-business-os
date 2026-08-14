import { describe, expect, it, vi } from 'vitest';
import { AnalyticsService } from '../src/service';
import {
  conversionRate,
  escalationSummary,
  recentConversations,
  recoveryRates,
  salesBuckets,
  toNumber,
  toPeakHours,
  toTopProducts,
} from '../src/assemble';
import type { PrismaClient } from '../../db/src';

function fakePrisma() {
  return {
    business: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  } as unknown as PrismaClient;
}

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14T12:00:00Z

function makeService(prisma: PrismaClient, businessId = 'biz-1') {
  return new AnalyticsService({ prisma, timeZone: 'Africa/Lagos', businessId });
}

describe('assemble (pure aggregation math)', () => {
  it('coerces raw money/quantity cells (numeric, Decimal-as-string, null) to numbers', () => {
    expect(toNumber('85000.00')).toBe(85000);
    expect(toNumber(85000)).toBe(85000);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  it('salesBuckets maps one raw row to today/week/month with orders', () => {
    const buckets = salesBuckets({
      todayRevenue: '125000.00',
      todayOrders: 2,
      weekRevenue: '410000.00',
      weekOrders: 7,
      monthRevenue: '1200000.00',
      monthOrders: 22,
    });
    expect(buckets).toEqual([
      { label: 'today', revenue: 125000, orders: 2 },
      { label: 'week', revenue: 410000, orders: 7 },
      { label: 'month', revenue: 1200000, orders: 22 },
    ]);
  });

  it('conversionRate clamps and handles zero chatted customers', () => {
    expect(conversionRate(10, 3)).toBe(0.3);
    expect(conversionRate(0, 0)).toBe(0);
    expect(conversionRate(10, 20)).toBe(1); // never above 100%
  });

  it('recoveryRates computes per-type and an OVERALL row', () => {
    const rates = recoveryRates([
      { type: 'CART', sent: 10, recovered: 4 },
      { type: 'PAYMENT', sent: 5, recovered: 2 },
    ]);
    expect(rates).toEqual([
      { type: 'CART', sent: 10, recovered: 4, rate: 0.4 },
      { type: 'PAYMENT', sent: 5, recovered: 2, rate: 0.4 },
      { type: 'OVERALL', sent: 15, recovered: 6, rate: 0.4 },
    ]);
  });

  it('escalationSummary folds the counts + byCategory rows', () => {
    const summary = escalationSummary(
      { total: 5, open: 2, resolved: 3, angry: 2, refundRequests: 1 },
      [
        { category: 'ANGRY_CUSTOMER', n: 2 },
        { category: 'REFUND_REQUEST', n: 1 },
        { category: 'OTHER', n: 2 },
      ],
    );
    expect(summary.total).toBe(5);
    expect(summary.open).toBe(2);
    expect(summary.byCategory).toEqual({ ANGRY_CUSTOMER: 2, REFUND_REQUEST: 1, OTHER: 2 });
  });

  it('recentConversations keeps only valid sentiment labels', () => {
    const rows = [
      { conversationId: 'c1', customerId: 'cust-1', name: 'Amina', waId: '2348', lastInbound: 'Hello', lastMessageAt: new Date(), sentiment: 'FRUSTRATED' },
      { conversationId: 'c2', customerId: 'cust-2', name: null, waId: '2349', lastInbound: null, lastMessageAt: null, sentiment: 'MADE_UP' },
    ];
    const list = recentConversations(rows);
    expect(list[0].sentiment).toBe('FRUSTRATED');
    expect(list[1].sentiment).toBeNull();
  });

  it('toTopProducts and toPeakHours coerce sample rows', () => {
    const products = toTopProducts([
      { productId: 'p1', name: 'Rice 50kg', quantity: 12, revenue: '1020000.00' },
      { productId: 'p2', name: 'Milo 900g', quantity: 3, revenue: '150000.00' },
    ]);
    expect(products[0]).toEqual({ productId: 'p1', name: 'Rice 50kg', quantity: 12, revenue: 1020000 });

    const hours = toPeakHours([
      { hour: 10, n: 8 },
      { hour: 18, n: 6 },
    ]);
    expect(hours).toEqual([
      { hour: 10, count: 8 },
      { hour: 18, count: 6 },
    ]);
  });
});

describe('AnalyticsService (read-only queries, mocked rows)', () => {
  it('sales() maps the single aggregate row into today/week/month buckets', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw = vi.fn().mockResolvedValue([
      { todayRevenue: '125000.00', todayOrders: 2, weekRevenue: '410000.00', weekOrders: 7, monthRevenue: '1200000.00', monthOrders: 22 },
    ]) as never;
    const service = makeService(prisma);

    const sales = await service.sales(NOW);

    expect(sales.todayOrders).toBe(2);
    expect(sales.monthRevenue).toBe('1200000.00');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('conversion() returns the distinct-customer counts', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw = vi.fn().mockResolvedValue([{ chatted: 30, converted: 9 }]) as never;
    const service = makeService(prisma);

    const conv = await service.conversion(NOW);

    expect(conv).toEqual({ chatted: 30, converted: 9 });
  });

  it('recovery() returns per-type rows for the follow-up engine', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw = vi.fn().mockResolvedValue([
      { type: 'CART', sent: 10, recovered: 4 },
      { type: 'PAYMENT', sent: 5, recovered: 2 },
    ]) as never;
    const service = makeService(prisma);

    const recovery = await service.recovery();

    expect(recovery).toHaveLength(2);
    expect(recovery[0]).toMatchObject({ type: 'CART', sent: 10, recovered: 4 });
  });

  it('escalations() returns the summary and the category breakdown', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ total: 5, open: 2, resolved: 3, angry: 2, refundRequests: 1 }])
      .mockResolvedValueOnce([
        { category: 'ANGRY_CUSTOMER', n: 2 },
        { category: 'REFUND_REQUEST', n: 1 },
        { category: 'OTHER', n: 2 },
      ]) as never;
    const service = makeService(prisma);

    const { summary, byCategory } = await service.escalations(NOW);

    expect(summary.total).toBe(5);
    expect(summary.angry).toBe(2);
    expect(byCategory).toHaveLength(3);
  });

  it('recentConversations() passes through the lateral-join rows', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw = vi.fn().mockResolvedValue([
      { conversationId: 'c1', customerId: 'cust-1', name: 'Amina', waId: '2348', lastInbound: 'Where is my order?', lastMessageAt: new Date(NOW), sentiment: 'FRUSTRATED' },
    ]) as never;
    const service = makeService(prisma);

    const recent = await service.recentConversations();

    expect(recent[0]).toMatchObject({ conversationId: 'c1', sentiment: 'FRUSTRATED' });
  });

  it('overview() assembles every metric from the query methods and computes rates', async () => {
    const prisma = fakePrisma();
    const service = makeService(prisma);
    vi.spyOn(service, 'sales').mockResolvedValue({
      todayRevenue: '125000.00',
      todayOrders: 2,
      weekRevenue: '410000.00',
      weekOrders: 7,
      monthRevenue: '1200000.00',
      monthOrders: 22,
    });
    vi.spyOn(service, 'topProducts').mockResolvedValue([
      { productId: 'p1', name: 'Rice 50kg', quantity: 12, revenue: '1020000.00' },
    ]);
    vi.spyOn(service, 'peakHours').mockResolvedValue([{ hour: 10, n: 8 }]);
    vi.spyOn(service, 'conversion').mockResolvedValue({ chatted: 30, converted: 9 });
    vi.spyOn(service, 'recovery').mockResolvedValue([
      { type: 'CART', sent: 10, recovered: 4 },
      { type: 'PAYMENT', sent: 5, recovered: 2 },
    ]);
    vi.spyOn(service, 'escalations').mockResolvedValue({
      summary: { total: 5, open: 2, resolved: 3, angry: 2, refundRequests: 1 },
      byCategory: [{ category: 'ANGRY_CUSTOMER', n: 2 }],
    });
    vi.spyOn(service, 'recentConversations').mockResolvedValue([
      { conversationId: 'c1', customerId: 'cust-1', name: 'Amina', waId: '2348', lastInbound: 'Hello', lastMessageAt: new Date(NOW), sentiment: 'POSITIVE' },
    ]);

    const data = await service.overview(NOW);

    expect(data.sales[0]).toEqual({ label: 'today', revenue: 125000, orders: 2 });
    expect(data.conversion).toEqual({ chatted: 30, converted: 9, rate: 0.3 });
    expect(data.recovery).toEqual([
      { type: 'CART', sent: 10, recovered: 4, rate: 0.4 },
      { type: 'PAYMENT', sent: 5, recovered: 2, rate: 0.4 },
      { type: 'OVERALL', sent: 15, recovered: 6, rate: 0.4 },
    ]);
    expect(data.escalations.angry).toBe(2);
    expect(data.topProducts[0].revenue).toBe(1020000);
    expect(data.peakHours[0]).toEqual({ hour: 10, count: 8 });
    expect(data.recentConversations[0].sentiment).toBe('POSITIVE');
    expect(data.generatedAt.toISOString()).toBe(new Date(NOW).toISOString());
  });

  it('overview() returns an empty dashboard when no business exists', async () => {
    const prisma = fakePrisma();
    prisma.business.findFirst = vi.fn().mockResolvedValue(null) as never;
    const service = new AnalyticsService({ prisma, timeZone: 'Africa/Lagos' });

    const data = await service.overview(NOW);

    expect(data.sales.map((s) => s.revenue)).toEqual([0, 0, 0]);
    expect(data.conversion.rate).toBe(0);
    expect(data.recovery[0]).toEqual({ type: 'OVERALL', sent: 0, recovered: 0, rate: 0 });
    expect(data.topProducts).toEqual([]);
  });
});