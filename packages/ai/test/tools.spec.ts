import { describe, expect, it, vi } from 'vitest';
import { TOOLS, findTool, type ToolContext } from '../src/tools';
import type { AuditService } from '../../audit/src';
import { AUDIT_ACTIONS, AUDIT_ACTOR, ORDER_STATUS } from '../../shared/src';

function product(id: string, name: string, price: number, qty = 10, reserved = 0) {
  return {
    id,
    name,
    description: `${name} description`,
    price,
    currency: 'NGN',
    category: 'Groceries',
    sku: `SKU-${id}`,
    isActive: true,
    stockLevels: [{ quantity: qty, reserved }],
  };
}

type FakeProduct = ReturnType<typeof product>;

/** Minimal Prisma fake supporting just what the tool handlers use. */
function makePrisma(products: FakeProduct[]) {
  const createdOrders: unknown[] = [];
  const createdItems: unknown[] = [];
  const self = {
    product: {
      findMany: vi.fn(async ({ where }: { where?: { name?: { contains: string } } } = {}) => {
        const query = where?.name?.contains?.toLowerCase();
        return products.filter((p) => !query || p.name.toLowerCase().includes(query));
      }),
      findFirst: vi.fn(async ({ where }: { where?: { id?: string; sku?: string } } = {}): Promise<unknown> => {
        if (where?.id) return products.find((p) => p.id === where.id) ?? null;
        if (where?.sku) return products.find((p) => p.sku === where.sku) ?? null;
        return null;
      }),
    },
    order: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `order-${createdOrders.length + 1}`;
        createdOrders.push({ ...data, id });
        return { id, ...data };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = createdOrders.find((o) => (o as { id: string }).id === where.id) ?? { id: where.id };
        return { ...existing, ...data };
      }),
    },
    payment: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `pay-${createdOrders.length + 1}`, ...data })),
    },
    followUp: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self)),
    createdOrders,
    createdItems,
  };
  return self;
}

function makeCtx(prisma: ReturnType<typeof makePrisma>, overrides: { paystack?: unknown } = {}): ToolContext {
  const audit = {
    record: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
  return {
    prisma: prisma as never,
    audit,
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerWaId: '2348012345678',
    conversationId: 'conv-1',
    currency: 'NGN',
    cart: { items: [] },
    cartDirty: false,
    paystack: overrides.paystack as never,
  };
}

describe('agent tools', () => {
  it('registers every tool with a handler', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      [
        'add_to_cart',
        'create_order',
        'create_payment_link',
        'escalate_to_human',
        'get_order_status',
        'get_product',
        'get_stock',
        'search_products',
        'update_order_address',
        'view_cart',
      ].sort(),
    );
    for (const tool of TOOLS) expect(typeof tool.handler).toBe('function');
  });

  describe('search_products', () => {
    it('filters by name and reports inStock as quantity minus reserved', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 40), product('p2', 'Indomie Noodles 4pk', 2400, 10)]);
      const result = await findTool('search_products')!.handler(makeCtx(prisma), { query: 'rice' });
      expect(result.ok).toBe(true);
      const products = result.data as { products: Array<{ id: string; inStock: number; price: number }> };
      expect(products.products).toHaveLength(1);
      expect(products.products[0].id).toBe('p1');
      expect(products.products[0].inStock).toBe(40);
      expect(products.products[0].price).toBe(85000);
    });

    it('lists everything with an empty query', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000), product('p2', 'Palm Oil 5L', 14500)]);
      const result = await findTool('search_products')!.handler(makeCtx(prisma), {});
      const products = result.data as { products: unknown[] };
      expect(products.products).toHaveLength(2);
    });

    it('reports reduced stock when reserved', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 10, 3)]);
      const result = await findTool('search_products')!.handler(makeCtx(prisma), {});
      const products = result.data as { products: Array<{ inStock: number }> };
      expect(products.products[0].inStock).toBe(7);
    });
  });

  describe('get_product', () => {
    it('returns full details for a known product', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000)]);
      const result = await findTool('get_product')!.handler(makeCtx(prisma), { id: 'p1' });
      expect(result.ok).toBe(true);
      expect((result.data as { product: { name: string } }).product.name).toBe('Rice 50kg');
    });

    it('fails fast for an unknown product', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('get_product')!.handler(makeCtx(prisma), { id: 'nope' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Product not found');
    });
  });

  describe('get_stock', () => {
    it('returns quantity, reserved and available for a known sku', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 10, 3)]);
      const result = await findTool('get_stock')!.handler(makeCtx(prisma), { sku: 'SKU-p1' });
      expect(result.ok).toBe(true);
      const data = result.data as { product: { name: string }; quantity: number; reserved: number; available: number };
      expect(data.product.name).toBe('Rice 50kg');
      expect(data.quantity).toBe(10);
      expect(data.reserved).toBe(3);
      expect(data.available).toBe(7);
    });

    it('rejects an unknown sku', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('get_stock')!.handler(makeCtx(prisma), { sku: 'SKU-nope' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('No product found for that SKU');
    });
  });

  describe('add_to_cart / view_cart', () => {
    it('adds a product to the cart and marks it dirty', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 40)]);
      const ctx = makeCtx(prisma);
      const result = await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 2 });

      expect(result.ok).toBe(true);
      expect(ctx.cart.items).toHaveLength(1);
      expect(ctx.cart.items[0]).toMatchObject({ productId: 'p1', quantity: 2, unitPrice: 85000, total: 170000 });
      expect(ctx.cartDirty).toBe(true);
    });

    it('merges quantity when the same product is added again', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 40)]);
      const ctx = makeCtx(prisma);
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 2 });
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 3 });
      expect(ctx.cart.items[0].quantity).toBe(5);
      expect(ctx.cart.items[0].total).toBe(425000);
    });

    it('rejects adding more than available stock', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 4)]);
      const ctx = makeCtx(prisma);
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 3 });
      const result = await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 2 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Only 4 left in stock');
    });

    it('rejects an unknown product', async () => {
      const prisma = makePrisma([]);
      const ctx = makeCtx(prisma);
      const result = await findTool('add_to_cart')!.handler(ctx, { product_id: 'nope', quantity: 1 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Product not found');
    });

    it('view_cart reports items, subtotal and itemCount', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 40), product('p2', 'Palm Oil 5L', 14500, 40)]);
      const ctx = makeCtx(prisma);
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 2 });
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p2', quantity: 1 });
      const result = await findTool('view_cart')!.handler(ctx, {});
      const cart = (result.data as { cart: { subtotal: number; itemCount: number } }).cart;
      expect(cart.subtotal).toBe(170000 + 14500);
      expect(cart.itemCount).toBe(3);
    });
  });

  describe('create_order', () => {
    it('creates a DRAFT order with line items, computes totals, and audits ORDER_CREATED', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000), product('p2', 'Palm Oil 5L', 14500)]);
      const ctx = makeCtx(prisma);
      const result = await findTool('create_order')!.handler(ctx, {
        items: [
          { product_id: 'p1', quantity: 2 },
          { product_id: 'p2', quantity: 1 },
        ],
        note: 'Door number 12, Ikeja',
      });

      expect(result.ok).toBe(true);
      const order = (result.data as { order: { id: string; status: string; subtotal: number } }).order;
      expect(order.status).toBe(ORDER_STATUS.DRAFT);
      expect(order.subtotal).toBe(85000 * 2 + 14500);

      const createCall = prisma.order.create.mock.calls[0][0] as { data: { status: string; notes: string } };
      expect(createCall.data.status).toBe(ORDER_STATUS.DRAFT);
      expect(createCall.data.notes).toBe('Door number 12, Ikeja');
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AUDIT_ACTIONS.ORDER_CREATED, actorType: AUDIT_ACTOR.AI_AGENT, entityType: 'ORDER' }),
      );
    });

    it('rejects an order with no items', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('create_order')!.handler(makeCtx(prisma), { items: [] });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('No items provided — add items to the cart first');
    });

    it('places the order from the cart when items are omitted, then clears the cart', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 40), product('p2', 'Palm Oil 5L', 14500, 40)]);
      const ctx = makeCtx(prisma);
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p1', quantity: 2 });
      await findTool('add_to_cart')!.handler(ctx, { product_id: 'p2', quantity: 1 });
      const result = await findTool('create_order')!.handler(ctx, {});

      expect(result.ok).toBe(true);
      const order = (result.data as { order: { subtotal: number } }).order;
      expect(order.subtotal).toBe(170000 + 14500);
      expect(ctx.cart.items).toHaveLength(0);
      expect(ctx.cartDirty).toBe(true);
    });

    it('rejects a quantity exceeding available stock', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000, 2)]);
      const result = await findTool('create_order')!.handler(makeCtx(prisma), {
        items: [{ product_id: 'p1', quantity: 5 }],
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Insufficient stock/);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('marks sent follow-ups as ledToOrder when the cart is converted to an order', async () => {
      const prisma = makePrisma([product('p1', 'Rice 50kg', 85000)]);
      prisma.followUp.updateMany.mockResolvedValueOnce({ count: 1 });
      const ctx = makeCtx(prisma);

      const result = await findTool('create_order')!.handler(ctx, { items: [{ product_id: 'p1', quantity: 1 }] });

      expect(result.ok).toBe(true);
      expect(prisma.followUp.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ conversationId: 'conv-1', status: 'SENT', ledToOrder: false }),
          data: { ledToOrder: true },
        }),
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AUDIT_ACTIONS.ORDER_ATTRIBUTED_TO_FOLLOW_UP, entityId: 'order-1' }),
      );
    });
  });

  describe('get_order_status', () => {
    it('returns order + payment status for the customer', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce({
        id: 'o1',
        status: ORDER_STATUS.PAYMENT_PENDING,
        total: 169500,
        currency: 'NGN',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        fulfilledAt: null,
        deliveryAddress: '12 Murtala Road, Kano',
        notes: 'Call on arrival',
        payments: [{ status: 'PENDING' }],
      });
      const result = await findTool('get_order_status')!.handler(makeCtx(prisma), { order_id: 'o1' });
      expect(result.ok).toBe(true);
      const order = (result.data as { order: { status: string; paymentStatus: string; total: number; deliveryAddress: string | null; notes: string | null } }).order;
      expect(order.status).toBe(ORDER_STATUS.PAYMENT_PENDING);
      expect(order.paymentStatus).toBe('PENDING');
      expect(order.total).toBe(169500);
      expect(order.deliveryAddress).toBe('12 Murtala Road, Kano');
      expect(order.notes).toBe('Call on arrival');
    });

    it('reports a missing order', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('get_order_status')!.handler(makeCtx(prisma), { order_id: 'missing' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Order not found');
    });
  });

  describe('create_payment_link', () => {
    const orderFor = (overrides: Record<string, unknown> = {}) => ({
      id: 'o1',
      status: ORDER_STATUS.DRAFT,
      total: 169500,
      currency: 'NGN',
      ...overrides,
    });
    // Fresh spy per test so call-count assertions never leak across tests.
    const makePaystack = () => ({
      initializeTransaction: vi.fn(async (input: { reference: string }) => ({
        reference: input.reference,
        accessCode: 'AC-1',
        authorizationUrl: `https://paystack.com/pay/${input.reference}`,
      })),
    });

    it('initializes a Paystack transaction from the DB order total and stores the payment', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor());
      const paystack = makePaystack();
      const ctx = makeCtx(prisma, { paystack });
      const spy = paystack.initializeTransaction;

      const result = await findTool('create_payment_link')!.handler(ctx, { order_id: 'o1' });

      expect(result.ok).toBe(true);
      const data = result.data as { payment: { paymentUrl: string; reference: string }; order: { status: string } };
      expect(data.payment.paymentUrl).toBe(`https://paystack.com/pay/${data.payment.reference}`);
      expect(data.order.status).toBe(ORDER_STATUS.PAYMENT_PENDING);
      // The amount is never taken from the model — it comes from the order total, in kobo.
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ amountKobo: 169500 * 100, currency: 'NGN' }),
      );
      // Reference is derived from the order id (greppable in Paystack).
      const callArgs = spy.mock.calls[0][0] as { reference: string; email: string };
      expect(callArgs.reference).toMatch(/^PAYo1[0-9a-f]{8}$/);
      expect(callArgs.email).toBe('2348012345678@wa.local');
      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ orderId: 'o1', status: 'PENDING', reference: callArgs.reference }),
        }),
      );
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'o1' }, data: expect.objectContaining({ status: ORDER_STATUS.PAYMENT_PENDING }) }),
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AUDIT_ACTIONS.PAYMENT_LINK_CREATED, entityId: expect.stringContaining('pay-') }),
      );
    });

    it('reuses a still-pending payment instead of charging twice', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor({ status: ORDER_STATUS.PAYMENT_PENDING }));
      prisma.payment.findFirst.mockResolvedValueOnce({
        reference: 'PAY-o1-old',
        status: 'PENDING',
        providerPayload: { authorizationUrl: 'https://paystack.com/pay/old' },
      });
      const paystack = makePaystack();
      const ctx = makeCtx(prisma, { paystack });

      const result = await findTool('create_payment_link')!.handler(ctx, { order_id: 'o1' });

      expect(result.ok).toBe(true);
      expect((result.data as { reused: boolean; payment: { paymentUrl: string } }).reused).toBe(true);
      expect((result.data as { payment: { paymentUrl: string } }).payment.paymentUrl).toBe('https://paystack.com/pay/old');
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('refuses when payments are not configured', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor());
      const result = await findTool('create_payment_link')!.handler(makeCtx(prisma), { order_id: 'o1' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not configured/);
    });

    it('refuses an already-paid or cancelled order', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor({ status: ORDER_STATUS.PAID }));
      const paystack = makePaystack();
      const paid = await findTool('create_payment_link')!.handler(makeCtx(prisma, { paystack }), { order_id: 'o1' });
      expect(paid.ok).toBe(false);
      expect(paid.error).toMatch(/already paid/);

      prisma.order.findFirst.mockResolvedValueOnce(orderFor({ status: ORDER_STATUS.CANCELLED }));
      const cancelled = await findTool('create_payment_link')!.handler(makeCtx(prisma, { paystack }), { order_id: 'o1' });
      expect(cancelled.ok).toBe(false);
      expect(cancelled.error).toMatch(/cancelled/);
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    });
  });

  describe('update_order_address', () => {
    const orderFor = (status: string) => ({
      id: 'o1',
      status,
      deliveryAddress: 'Old address',
    });

    it('updates the delivery address and audits it', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor(ORDER_STATUS.PAID));
      prisma.order.update.mockResolvedValueOnce({ id: 'o1', status: ORDER_STATUS.PAID, deliveryAddress: 'New address' });
      const ctx = makeCtx(prisma);

      const result = await findTool('update_order_address')!.handler(ctx, { order_id: 'o1', address: 'New address' });

      expect(result.ok).toBe(true);
      expect((result.data as { order: { deliveryAddress: string } }).order.deliveryAddress).toBe('New address');
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'o1' },
          data: { deliveryAddress: 'New address' },
        }),
      );
      expect(ctx.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AUDIT_ACTIONS.DELIVERY_ADDRESS_UPDATED, entityId: 'o1' }),
      );
    });

    it('rejects an address change after fulfilment', async () => {
      const prisma = makePrisma([]);
      prisma.order.findFirst.mockResolvedValueOnce(orderFor(ORDER_STATUS.FULFILLED));
      const result = await findTool('update_order_address')!.handler(makeCtx(prisma), { order_id: 'o1', address: 'New address' });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no longer be changed/);
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('rejects when the order is not found', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('update_order_address')!.handler(makeCtx(prisma), { order_id: 'missing', address: 'X' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Order not found');
    });

    it('requires order_id and address', async () => {
      const prisma = makePrisma([]);
      expect((await findTool('update_order_address')!.handler(makeCtx(prisma), { address: 'X' })).ok).toBe(false);
      expect((await findTool('update_order_address')!.handler(makeCtx(prisma), { order_id: 'o1' })).ok).toBe(false);
    });
  });

  describe('escalate_to_human', () => {
    it('acknowledges escalation with the given reason and category', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('escalate_to_human')!.handler(makeCtx(prisma), {
        reason: 'customer asked for a human',
        category: 'angry_customer',
      });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({
        escalated: true,
        reason: 'customer asked for a human',
        category: 'angry_customer',
      });
    });

    it('defaults the category to null when not given', async () => {
      const prisma = makePrisma([]);
      const result = await findTool('escalate_to_human')!.handler(makeCtx(prisma), { reason: 'unsure' });
      expect((result.data as { category: string | null }).category).toBeNull();
    });
  });
});