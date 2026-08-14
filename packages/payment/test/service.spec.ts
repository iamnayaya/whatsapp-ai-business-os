import { describe, expect, it, vi } from 'vitest';
import { PaymentService } from '../src/service';
import type { AuditService } from '../../audit/src';
import type { WhatsAppClient } from '../../whatsapp/src';
import { createLogger, AUDIT_ACTIONS, ORDER_STATUS, PAYMENT_STATUS } from '../../shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

interface OrderSeed {
  id: string;
  businessId?: string;
  customerId?: string;
  currency?: string;
  total: number;
  status?: string;
  confirmationSentAt?: Date | null;
  trackingReference?: string | null;
  items: Array<{ productId: string; productName: string; quantity: number; unitPrice: number }>;
  business?: { name: string };
  customer?: { id: string; waId: string; name: string | null; profileName: string | null };
}

interface PaymentSeed {
  id: string;
  orderId: string;
  reference: string;
  amount: number;
  currency?: string;
  status?: string;
}

interface PrismaFake {
  payment: {
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  order: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  stockLevel: { updateMany: ReturnType<typeof vi.fn> };
  conversation: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  message: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  getOrder(id: string): Record<string, any>;
  getPayment(reference: string): Record<string, any> | undefined;
  getStock(productId: string): number;
  _createdMessages: Array<Record<string, any>>;
}

/** In-memory Prisma fake with Postgres-semantics for the money-critical ops. */
function makePrisma(opts: { stocks?: Record<string, number>; orders?: OrderSeed[]; payments?: PaymentSeed[] } = {}): PrismaFake {
  const stocks = new Map<string, number>(Object.entries(opts.stocks ?? {}));
  const orders: Array<Record<string, any>> = (opts.orders ?? []).map((o) => ({
    id: o.id,
    businessId: o.businessId ?? 'biz-1',
    customerId: o.customerId ?? 'cust-1',
    currency: o.currency ?? 'NGN',
    total: o.total,
    status: o.status ?? ORDER_STATUS.PAYMENT_PENDING,
    deliveryStatus: 'PENDING',
    confirmationSentAt: o.confirmationSentAt ?? null,
    trackingReference: o.trackingReference ?? null,
    paidAt: null,
    items: o.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice, product: { name: i.productName } })),
    business: o.business ?? { name: 'Ahmad Nayaya' },
    customer: o.customer ?? { id: 'cust-1', waId: '2348012345678', name: 'Amina', profileName: null },
  }));
  const payments: Array<Record<string, any>> = (opts.payments ?? []).map((p) => ({
    id: p.id,
    orderId: p.orderId,
    reference: p.reference,
    amount: p.amount,
    currency: p.currency ?? 'NGN',
    status: p.status ?? PAYMENT_STATUS.PENDING,
    providerPayload: null,
    confirmedAt: null,
  }));
  const createdMessages: Array<Record<string, any>> = [];

  const stockUpdateMany = vi.fn(async ({ where, data }: { where: { productId: string; quantity?: { gte?: number } }; data: { quantity?: { decrement?: number } } }) => {
    const current = stocks.get(where.productId) ?? 0;
    const need = where.quantity?.gte ?? 0;
    const qty = data.quantity?.decrement ?? 0;
    if (current >= need) {
      stocks.set(where.productId, current - qty);
      return { count: 1 };
    }
    return { count: 0 };
  });

  const paymentUpdateMany = vi.fn(async ({ where, data }: { where: { id: string; status?: string | { not?: string } }; data: Record<string, unknown> }) => {
    const payment = payments.find((p) => p.id === where.id);
    if (!payment) return { count: 0 };
    let matches = true;
    if (where.status && typeof where.status === 'object' && 'not' in where.status) {
      matches = payment.status !== where.status.not;
    } else if (where.status) {
      matches = payment.status === where.status;
    }
    if (!matches) return { count: 0 };
    Object.assign(payment, data);
    return { count: 1 };
  });

  const orderUpdateMany = vi.fn(async ({ where, data }: { where: { id: string; status?: string; confirmationSentAt?: Date | null | { not?: unknown } }; data: Record<string, unknown> }) => {
    const order = orders.find((o) => o.id === where.id);
    if (!order) return { count: 0 };
    let matches = true;
    if (where.status && order.status !== where.status) matches = false;
    if (matches && 'confirmationSentAt' in where) {
      if (where.confirmationSentAt === null) matches = order.confirmationSentAt === null;
      else if (typeof where.confirmationSentAt === 'object' && where.confirmationSentAt !== null && 'not' in where.confirmationSentAt) {
        matches = order.confirmationSentAt !== null;
      } else if (where.confirmationSentAt instanceof Date) {
        matches = order.confirmationSentAt?.getTime() === where.confirmationSentAt.getTime();
      }
    }
    if (!matches) return { count: 0 };
    Object.assign(order, data);
    return { count: 1 };
  });

  const orderUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const order = orders.find((o) => o.id === where.id);
    if (!order) throw new Error('order not found');
    Object.assign(order, data);
    return { ...order };
  });

  const self: PrismaFake = {
    payment: {
      findUnique: vi.fn(async ({ where }: { where: { reference: string } }) => payments.find((p) => p.reference === where.reference) ?? null),
      updateMany: paymentUpdateMany,
    },
    order: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => orders.find((o) => o.id === where.id) ?? null),
      update: orderUpdate,
      updateMany: orderUpdateMany,
    },
    stockLevel: { updateMany: stockUpdateMany },
    conversation: {
      findFirst: vi.fn(async () => ({ id: 'conv-1', businessId: 'biz-1', customerId: 'cust-1' })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    message: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `msg-${createdMessages.length + 1}`, ...data };
        createdMessages.push(row);
        return row;
      }),
    },
    // Runs fn against the same in-memory state; on throw, restores ONLY the
    // stock keys / order ids this transaction itself touched (Postgres
    // semantics) so a concurrent transaction's committed changes survive.
    $transaction: vi.fn(async (fn: (tx: PrismaFake) => Promise<unknown>) => {
      const touchedStocks = new Set<string>();
      const touchedOrders = new Set<string>();
      const stocksSnapshot = new Map(stocks);
      const ordersSnapshot = new Map(orders.map((o) => [o.id, { ...o }]));
      const tx = {
        ...self,
        stockLevel: {
          updateMany: async (args: Parameters<typeof stockUpdateMany>[0]) => {
            const res = await stockUpdateMany(args);
            touchedStocks.add(args.where.productId);
            return res;
          },
        },
        order: {
          ...self.order,
          update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
            const res = await orderUpdate(args);
            touchedOrders.add(args.where.id);
            return res;
          },
        },
      } as unknown as PrismaFake;
      try {
        return await fn(tx);
      } catch (err) {
        for (const key of touchedStocks) stocks.set(key, stocksSnapshot.get(key) ?? 0);
        for (const id of touchedOrders) {
          const snap = ordersSnapshot.get(id);
          const idx = orders.findIndex((o) => o.id === id);
          if (idx >= 0 && snap) orders[idx] = { ...snap };
        }
        throw err;
      }
    }),
    getOrder: (id: string) => {
      const order = orders.find((o) => o.id === id);
      if (!order) throw new Error(`order not found: ${id}`);
      return order;
    },
    getPayment: (reference: string) => payments.find((p) => p.reference === reference),
    getStock: (productId: string) => stocks.get(productId) ?? 0,
    _createdMessages: createdMessages,
  };
  return self;
}

function makeDeps(prisma: PrismaFake, overrides: { whatsapp?: { sendText: ReturnType<typeof vi.fn> } } = {}) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const whatsapp = overrides.whatsapp ?? {
    sendText: vi.fn(async () => ({ waMessageId: 'wamid.pay.1' })),
  };
  const deps = {
    prisma: prisma as never,
    whatsapp: whatsapp as unknown as WhatsAppClient,
    audit: audit as unknown as AuditService,
    logger: silentLogger,
  };
  return { deps, audit: audit as unknown as { record: ReturnType<typeof vi.fn> }, whatsapp: whatsapp as { sendText: ReturnType<typeof vi.fn> } };
}

const ORDER = {
  id: 'order-1',
  total: 169500,
  items: [{ productId: 'p1', productName: 'Rice 50kg', quantity: 2, unitPrice: 85000 }],
};
const PAY = { id: 'pay-1', orderId: 'order-1', reference: 'PAY-ref-1', amount: 169500 };
const SUCCESS = { event: 'charge.success', data: { reference: 'PAY-ref-1', amount: 16950000 } };

describe('PaymentService', () => {
  it('confirms a charge.success: payment SUCCESS, order PAID + tracking, stock deducted, confirmation sent', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps, audit, whatsapp } = makeDeps(prisma);
    const service = new PaymentService(deps);

    const outcome = await service.handleChargeEvent(SUCCESS);

    expect(outcome).toMatchObject({ kind: 'paid', orderId: 'order-1', paymentId: 'pay-1' });
    expect((outcome as { trackingReference: string }).trackingReference).toMatch(/^TRK-/);
    expect(prisma.getPayment('PAY-ref-1')?.status).toBe(PAYMENT_STATUS.SUCCESS);
    const order = prisma.getOrder('order-1');
    expect(order.status).toBe(ORDER_STATUS.PAID);
    expect(order.deliveryStatus).toBe('PROCESSING');
    expect(order.trackingReference).toMatch(/^TRK-/);
    expect(prisma.getStock('p1')).toBe(8);
    expect(whatsapp.sendText).toHaveBeenCalledWith('2348012345678', expect.stringContaining('TRK-'));
    expect(whatsapp.sendText).toHaveBeenCalledWith('2348012345678', expect.stringContaining('2x Rice 50kg'));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.PAYMENT_CONFIRMED }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.STOCK_DEDUCTED }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.PAYMENT_CONFIRMATION_SENT }));
    expect(prisma._createdMessages).toHaveLength(1);
  });

  it('is idempotent against a duplicate charge.success delivery', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new PaymentService(deps);

    await service.handleChargeEvent(SUCCESS);
    const second = await service.handleChargeEvent(SUCCESS);

    expect(second.kind).toBe('duplicate');
    expect(prisma.getStock('p1')).toBe(8); // deducted exactly once
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1); // one confirmation
    expect(prisma._createdMessages).toHaveLength(1);
  });

  it('marks a failed payment FAILED and leaves the order payable (no confirmation)', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps, audit, whatsapp } = makeDeps(prisma);
    const service = new PaymentService(deps);

    const outcome = await service.handleChargeEvent({ event: 'charge.failed', data: { reference: 'PAY-ref-1', status: 'failed' } });

    expect(outcome).toMatchObject({ kind: 'failed', orderId: 'order-1' });
    expect(prisma.getPayment('PAY-ref-1')?.status).toBe(PAYMENT_STATUS.FAILED);
    expect(prisma.getOrder('order-1').status).toBe(ORDER_STATUS.PAYMENT_PENDING);
    expect(prisma.getStock('p1')).toBe(10);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.PAYMENT_FAILED }));

    // A duplicate charge.failed delivery is a no-op.
    const again = await service.handleChargeEvent({ event: 'charge.failed', data: { reference: 'PAY-ref-1', status: 'failed' } });
    expect(again.kind).toBe('duplicate');
    expect(prisma.getPayment('PAY-ref-1')?.status).toBe(PAYMENT_STATUS.FAILED);
  });

  it('does not downgrade a payment after success (late charge.failed)', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps } = makeDeps(prisma);
    const service = new PaymentService(deps);

    await service.handleChargeEvent(SUCCESS);
    const outcome = await service.handleChargeEvent({ event: 'charge.failed', data: { reference: 'PAY-ref-1' } });

    expect(outcome.kind).toBe('ignored');
    expect(prisma.getPayment('PAY-ref-1')?.status).toBe(PAYMENT_STATUS.SUCCESS);
    expect(prisma.getOrder('order-1').status).toBe(ORDER_STATUS.PAID);
  });

  it('rejects an amount that does not match the payment (webhook never sets the price)', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps } = makeDeps(prisma);
    const service = new PaymentService(deps);

    const outcome = await service.handleChargeEvent({ event: 'charge.success', data: { reference: 'PAY-ref-1', amount: 100000 } });

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'amount_mismatch' });
    expect(prisma.getPayment('PAY-ref-1')?.status).toBe(PAYMENT_STATUS.FAILED);
    expect(prisma.getOrder('order-1').status).toBe(ORDER_STATUS.PAYMENT_PENDING);
    expect(prisma.getStock('p1')).toBe(10); // untouched
  });

  it('never oversells: the loser of a stock race is cancelled with a loud audit', async () => {
    const order1 = { id: 'order-1', total: 100000, items: [{ productId: 'p1', productName: 'Rice 50kg', quantity: 1, unitPrice: 100000 }] };
    const order2 = { id: 'order-2', total: 100000, items: [{ productId: 'p1', productName: 'Rice 50kg', quantity: 1, unitPrice: 100000 }] };
    const pay1 = { id: 'pay-1', orderId: 'order-1', reference: 'PAY-ref-1', amount: 100000 };
    const pay2 = { id: 'pay-2', orderId: 'order-2', reference: 'PAY-ref-2', amount: 100000 };
    const prisma = makePrisma({ stocks: { p1: 1 }, orders: [order1, order2], payments: [pay1, pay2] });
    const { deps, audit } = makeDeps(prisma);
    const service = new PaymentService(deps);

    // Two customers pay for the same last unit, effectively at the same time.
    const [a, b] = await Promise.all([
      service.handleChargeEvent({ event: 'charge.success', data: { reference: 'PAY-ref-1', amount: 10000000 } }),
      service.handleChargeEvent({ event: 'charge.success', data: { reference: 'PAY-ref-2', amount: 10000000 } }),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['paid', 'rejected']);
    const loser = a.kind === 'rejected' ? a : b;
    const winner = a.kind === 'paid' ? a : b;
    expect((loser as { reason: string }).reason).toBe('stock_race');
    const loserOrder = loser.kind === 'rejected' ? prisma.getOrder('order-2') : prisma.getOrder('order-1');
    const winnerOrder = winner.kind === 'paid' ? prisma.getOrder('order-1') : prisma.getOrder('order-2');
    expect(loserOrder.status).toBe(ORDER_STATUS.CANCELLED);
    expect(winnerOrder.status).toBe(ORDER_STATUS.PAID);
    expect(prisma.getStock('p1')).toBe(0); // never negative
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.STOCK_RACE_CONFLICT }));
  });

  it('re-sends the confirmation on a retry after a transient send failure', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const whatsapp = { sendText: vi.fn(async () => ({ waMessageId: 'wamid.pay.1' })) };
    const { deps } = makeDeps(prisma, { whatsapp });
    const service = new PaymentService(deps);

    whatsapp.sendText.mockRejectedValueOnce(new Error('whatsapp down'));
    await expect(service.handleChargeEvent(SUCCESS)).rejects.toThrow('whatsapp down');

    // Order is paid, but the confirmation claim was released for the retry.
    expect(prisma.getOrder('order-1').status).toBe(ORDER_STATUS.PAID);
    expect(prisma.getOrder('order-1').confirmationSentAt).toBeNull();
    expect(prisma.getStock('p1')).toBe(8); // not double-deducted

    // The retry re-enters through the already-claimed path and resends.
    whatsapp.sendText.mockResolvedValueOnce({ waMessageId: 'wamid.pay.1' });
    const retry = await service.handleChargeEvent(SUCCESS);
    expect(retry.kind).toBe('duplicate');
    expect(whatsapp.sendText).toHaveBeenCalledTimes(2);
    expect(prisma.getOrder('order-1').confirmationSentAt).not.toBeNull();
    expect(prisma.getStock('p1')).toBe(8);
  });

  it('ignores events for unknown references', async () => {
    const prisma = makePrisma({ stocks: { p1: 10 }, orders: [ORDER], payments: [PAY] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new PaymentService(deps);

    const outcome = await service.handleChargeEvent({ event: 'charge.success', data: { reference: 'NOPE' } });

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'unknown_reference' });
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });
});