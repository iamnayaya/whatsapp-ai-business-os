import { randomUUID } from 'crypto';
import { Prisma, type PrismaClient } from '../../db/src';
import type { AuditService } from '../../audit/src';
import { AUDIT_ACTIONS, AUDIT_ACTOR, FOLLOWUP_STATUS, ORDER_STATUS, PAYMENT_PROVIDER, PAYMENT_STATUS } from '../../shared/src/constants';
import { messageFromError } from '../../shared/src/errors';
import type { PaystackLike } from '../../paystack/src';
import type { GeminiFunctionDeclaration } from './types';

export interface CartItem {
  productId: string;
  productName: string;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  total: number;
}

export interface Cart {
  items: CartItem[];
  updatedAt?: string;
}

export interface ToolContext {
  prisma: PrismaClient;
  audit: AuditService;
  businessId: string;
  customerId: string;
  customerWaId: string;
  conversationId: string;
  currency: string;
  cart: Cart;
  cartDirty: boolean;
  /** Set when payments are configured; required by create_payment_link. */
  paystack?: PaystackLike;
}

export interface ToolResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function availableOf(product: { stockLevels?: Array<{ quantity: number; reserved: number }> }): number {
  return (product.stockLevels?.[0]?.quantity ?? 0) - (product.stockLevels?.[0]?.reserved ?? 0);
}

function serializeProduct(p: {
  id: string;
  name: string;
  description: string | null;
  price: Prisma.Decimal;
  currency: string;
  category: string | null;
  sku: string | null;
  stockLevels?: Array<{ quantity: number; reserved: number }>;
}): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    price: Number(p.price),
    currency: p.currency,
    category: p.category ?? null,
    sku: p.sku ?? null,
    inStock: availableOf(p),
  };
}

function cartSummary(cart: Cart): Record<string, unknown> {
  const subtotal = cart.items.reduce((sum, i) => sum + i.total, 0);
  return {
    items: cart.items.map((i) => ({ ...i })),
    subtotal,
    itemCount: cart.items.reduce((sum, i) => sum + i.quantity, 0),
  };
}

// ---------------------------------------------------------------------------
// Tool handlers. Each returns a JSON-safe object that becomes the model's
// `functionResponse` — flat, self-describing, and free of Graph/Decimal objects.
// ---------------------------------------------------------------------------

async function searchProducts(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const query = (rawArgs.query as string | undefined) ?? undefined;
  const products = await ctx.prisma.product.findMany({
    where: {
      businessId: ctx.businessId,
      isActive: true,
      ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
    },
    include: { stockLevels: true },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  return { ok: true, data: { products: products.map(serializeProduct) } };
}

async function getProduct(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const product = await ctx.prisma.product.findFirst({
    where: { id: String(rawArgs.id), businessId: ctx.businessId, isActive: true },
    include: { stockLevels: true },
  });
  if (!product) return { ok: false, error: 'Product not found' };
  return { ok: true, data: { product: serializeProduct(product) } };
}

async function getStock(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const sku = String(rawArgs.sku ?? '').trim();
  if (!sku) return { ok: false, error: 'sku is required' };
  const product = await ctx.prisma.product.findFirst({
    where: { sku, businessId: ctx.businessId, isActive: true },
    include: { stockLevels: true },
  });
  if (!product) return { ok: false, error: 'No product found for that SKU' };
  const quantity = product.stockLevels[0]?.quantity ?? 0;
  const reserved = product.stockLevels[0]?.reserved ?? 0;
  return {
    ok: true,
    data: {
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        price: Number(product.price),
        currency: product.currency,
      },
      quantity,
      reserved,
      available: quantity - reserved,
    },
  };
}

async function addToCart(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const productId = String(rawArgs.product_id ?? '');
  const quantity = Math.max(1, Math.floor(Number(rawArgs.quantity) || 1));
  if (!productId) return { ok: false, error: 'product_id is required' };

  const product = await ctx.prisma.product.findFirst({
    where: { id: productId, businessId: ctx.businessId, isActive: true },
    include: { stockLevels: true },
  });
  if (!product) return { ok: false, error: 'Product not found' };

  const available = availableOf(product);
  const existingQty = ctx.cart.items.find((i) => i.productId === productId)?.quantity ?? 0;
  if (existingQty + quantity > available) {
    return { ok: false, error: `Only ${available} left in stock` };
  }

  const unitPrice = Number(product.price);
  const line: CartItem = {
    productId: product.id,
    productName: product.name,
    sku: product.sku ?? null,
    unitPrice,
    quantity: existingQty + quantity,
    total: (existingQty + quantity) * unitPrice,
  };
  const idx = ctx.cart.items.findIndex((i) => i.productId === productId);
  if (idx >= 0) ctx.cart.items[idx] = line;
  else ctx.cart.items.push(line);
  ctx.cart.updatedAt = new Date().toISOString();
  ctx.cartDirty = true;

  return { ok: true, data: { cart: cartSummary(ctx.cart), added: { productId, quantity } } };
}

async function viewCart(ctx: ToolContext): Promise<ToolResult> {
  return { ok: true, data: { cart: cartSummary(ctx.cart) } };
}

async function createOrder(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const rawItems = rawArgs.items as Array<{ product_id: string; quantity: number }> | undefined;
  let sourceItems: Array<{ product_id: string; quantity: number }>;
  let fromCart = false;
  if (Array.isArray(rawItems) && rawItems.length > 0) {
    sourceItems = rawItems;
  } else if (ctx.cart.items.length > 0) {
    sourceItems = ctx.cart.items.map((i) => ({ product_id: i.productId, quantity: i.quantity }));
    fromCart = true;
  } else {
    return { ok: false, error: 'No items provided — add items to the cart first' };
  }

  try {
    const order = await ctx.prisma.$transaction(async (tx) => {
      let subtotal = 0;
      const lines: Array<{ productId: string; productName: string; unitPrice: number; quantity: number; total: number }> = [];
      for (const item of sourceItems) {
        const qty = Math.max(1, Math.floor(Number(item.quantity) || 1));
        const product = await tx.product.findFirst({
          where: { id: item.product_id, businessId: ctx.businessId, isActive: true },
          include: { stockLevels: true },
        });
        if (!product) throw new Error(`Product not found: ${item.product_id}`);
        const available = availableOf(product);
        if (available < qty) throw new Error(`Insufficient stock for "${product.name}" (only ${available} left)`);
        const lineTotal = Number(product.price) * qty;
        subtotal += lineTotal;
        lines.push({
          productId: product.id,
          productName: product.name,
          unitPrice: Number(product.price),
          quantity: qty,
          total: lineTotal,
        });
      }

      const created = await tx.order.create({
        data: {
          businessId: ctx.businessId,
          customerId: ctx.customerId,
          status: ORDER_STATUS.DRAFT,
          subtotal: new Prisma.Decimal(subtotal),
          total: new Prisma.Decimal(subtotal),
          currency: ctx.currency,
          notes: (rawArgs.note as string | undefined) ?? null,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitPrice: new Prisma.Decimal(l.unitPrice),
              total: new Prisma.Decimal(l.total),
            })),
          },
        },
      });

      await ctx.audit.record({
        businessId: ctx.businessId,
        actorType: AUDIT_ACTOR.AI_AGENT,
        action: AUDIT_ACTIONS.ORDER_CREATED,
        entityType: 'ORDER',
        entityId: created.id,
        details: { items: lines, subtotal, fromCart },
      });

      // Phase 5 attribution: if this conversation received abandoned-cart
      // follow-ups, mark them as having led to an order (analytics).
      const attributed = await tx.followUp.updateMany({
        where: { conversationId: ctx.conversationId, status: FOLLOWUP_STATUS.SENT, ledToOrder: false },
        data: { ledToOrder: true },
      });
      if (attributed.count > 0) {
        await ctx.audit.record({
          businessId: ctx.businessId,
          actorType: AUDIT_ACTOR.AI_AGENT,
          action: AUDIT_ACTIONS.ORDER_ATTRIBUTED_TO_FOLLOW_UP,
          entityType: 'ORDER',
          entityId: created.id,
          details: { conversationId: ctx.conversationId, followUpsAttributed: attributed.count },
        });
      }

      return { id: created.id, subtotal, lines };
    });

    // The cart was converted into an order — clear it.
    ctx.cart.items = [];
    ctx.cart.updatedAt = new Date().toISOString();
    ctx.cartDirty = true;

    return {
      ok: true,
      data: {
        order: { id: order.id, status: ORDER_STATUS.DRAFT, subtotal: order.subtotal, items: order.lines },
      },
    };
  } catch (err) {
    // Business validation failures (unknown product, insufficient stock) are
    // fed back to the model as a non-ok result so it can adjust; unexpected
    // errors propagate for BullMQ retry.
    const message = messageFromError(err);
    return { ok: false, error: message };
  }
}

async function getOrderStatus(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const order = await ctx.prisma.order.findFirst({
    where: { id: String(rawArgs.order_id), businessId: ctx.businessId, customerId: ctx.customerId },
    include: { payments: true },
  });
  if (!order) return { ok: false, error: 'Order not found' };
  const payment = order.payments.find((p) => p.status === PAYMENT_STATUS.PENDING) ?? order.payments[0];
  return {
    ok: true,
    data: {
      order: {
        id: order.id,
        status: order.status,
        total: Number(order.total ?? order.subtotal ?? 0),
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
        paymentStatus: payment?.status ?? 'NONE',
        paymentUrl: paymentUrlOf(payment),
        deliveryStatus: order.deliveryStatus,
        trackingReference: order.trackingReference ?? null,
        deliveryAddress: order.deliveryAddress ?? null,
        fulfilledAt: order.fulfilledAt ? order.fulfilledAt.toISOString() : null,
        notes: order.notes ?? null,
      },
    },
  };
}

async function escalateToHuman(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  return {
    ok: true,
    data: {
      escalated: true,
      reason: (rawArgs.reason as string | undefined) ?? 'Customer requested a human / agent was not confident',
      category: (rawArgs.category as string | undefined) ?? null,
    },
  };
}

async function updateOrderAddress(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const orderId = String(rawArgs.order_id ?? '').trim();
  const address = String(rawArgs.address ?? '').trim();
  if (!orderId) return { ok: false, error: 'order_id is required' };
  if (!address) return { ok: false, error: 'address is required' };

  const order = await ctx.prisma.order.findFirst({
    where: { id: orderId, businessId: ctx.businessId, customerId: ctx.customerId },
  });
  if (!order) return { ok: false, error: 'Order not found' };

  const LOCKED_ORDER_STATUSES: string[] = [ORDER_STATUS.FULFILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REFUNDED];
  if (LOCKED_ORDER_STATUSES.includes(order.status)) {
    return {
      ok: false,
      error: `Delivery address can no longer be changed: order is ${order.status.toLowerCase()}`,
    };
  }

  const updated = await ctx.prisma.order.update({
    where: { id: order.id },
    data: { deliveryAddress: address },
  });

  await ctx.audit.record({
    businessId: ctx.businessId,
    actorType: AUDIT_ACTOR.AI_AGENT,
    action: AUDIT_ACTIONS.DELIVERY_ADDRESS_UPDATED,
    entityType: 'ORDER',
    entityId: order.id,
    details: { orderId: order.id, address, fromStatus: order.status },
  });

  return {
    ok: true,
    data: {
      order: { id: updated.id, status: updated.status, deliveryAddress: updated.deliveryAddress },
      updated: true,
    },
  };
}

function paymentUrlOf(payment: { providerPayload: unknown } | undefined | null): string | null {
  const payload = payment?.providerPayload as { authorizationUrl?: string } | null;
  return typeof payload?.authorizationUrl === 'string' ? payload.authorizationUrl : null;
}

/**
 * Phase 7 — payment link. Called by the sales agent after create_order. The
 * AMOUNT is always read from the order total in the DB (never from the model
 * or a user-supplied value), converted to kobo, and a Payment row is created
 * with Paystack's authorization URL. Idempotent: a still-pending payment for
 * the same order is reused instead of charging a second time.
 */
async function createPaymentLink(ctx: ToolContext, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const orderId = String(rawArgs.order_id ?? '').trim();
  if (!orderId) return { ok: false, error: 'order_id is required' };
  if (!ctx.paystack) {
    return { ok: false, error: 'Payments are not configured on this server yet' };
  }

  const order = await ctx.prisma.order.findFirst({
    where: { id: orderId, businessId: ctx.businessId, customerId: ctx.customerId },
  });
  if (!order) return { ok: false, error: 'Order not found' };

  if (
    order.status === ORDER_STATUS.PAID ||
    order.status === ORDER_STATUS.FULFILLING ||
    order.status === ORDER_STATUS.FULFILLED ||
    order.status === ORDER_STATUS.REFUNDED
  ) {
    return { ok: false, error: `This order is already ${order.status.toLowerCase()} — no payment link is needed` };
  }
  if (order.status === ORDER_STATUS.CANCELLED) {
    return { ok: false, error: 'This order was cancelled — a fresh order is needed before payment' };
  }

  // Idempotent: reuse a still-open payment rather than charging twice.
  const existing = await ctx.prisma.payment.findFirst({
    where: { orderId: order.id, status: PAYMENT_STATUS.PENDING },
  });
  if (existing) {
    const existingUrl = paymentUrlOf(existing);
    if (existingUrl) {
      return {
        ok: true,
        data: {
          order: { id: order.id, status: order.status, amount: Number(order.total ?? 0), currency: order.currency },
          payment: { reference: existing.reference, paymentUrl: existingUrl },
          reused: true,
        },
      };
    }
  }

  const amountKobo = Math.round(Number(order.total ?? 0) * 100);
  if (!(amountKobo > 0)) {
    return { ok: false, error: 'Order total is not a positive amount — cannot generate a payment link' };
  }

  // Paystack reference: unique per transaction. Built from the order id so a
  // re-created link always differs while remaining human-greppable in Paystack.
  const reference = `PAY-${order.id}-${randomUUID().slice(0, 8)}`.replace(/-/g, '');
  const email = `${ctx.customerWaId}@wa.local`;

  let initiated;
  try {
    initiated = await ctx.paystack.initializeTransaction({
      amountKobo,
      email,
      reference,
      currency: order.currency,
      metadata: { orderId: order.id, businessId: ctx.businessId, customerId: ctx.customerId, customerWaId: ctx.customerWaId },
    });
  } catch (err) {
    return { ok: false, error: `Payment provider error: ${messageFromError(err)}` };
  }

  const payment = await ctx.prisma.payment.create({
    data: {
      orderId: order.id,
      provider: PAYMENT_PROVIDER.PAYSTACK,
      reference: initiated.reference,
      amount: new Prisma.Decimal(Number(order.total ?? 0)),
      currency: order.currency,
      status: PAYMENT_STATUS.PENDING,
      providerPayload: {
        authorizationUrl: initiated.authorizationUrl,
        accessCode: initiated.accessCode,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await ctx.prisma.order.update({
    where: { id: order.id },
    data: { status: ORDER_STATUS.PAYMENT_PENDING },
  });

  await ctx.audit.record({
    businessId: ctx.businessId,
    actorType: AUDIT_ACTOR.AI_AGENT,
    action: AUDIT_ACTIONS.PAYMENT_LINK_CREATED,
    entityType: 'PAYMENT',
    entityId: payment.id,
    details: { orderId: order.id, amountKobo, reference, currency: order.currency, paymentUrl: initiated.authorizationUrl },
  });

  return {
    ok: true,
    data: {
      order: { id: order.id, status: ORDER_STATUS.PAYMENT_PENDING, amount: Number(order.total ?? 0), currency: order.currency },
      payment: { reference: payment.reference, paymentUrl: initiated.authorizationUrl },
      reused: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool registry — declaration (sent to the model) + handler (executed here).
// ---------------------------------------------------------------------------

export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

const prop = (type: string, description: string): Record<string, unknown> => ({ type, description });

const TOOL_DEFS: Array<Omit<AgentTool, 'handler'>> = [
  {
    name: 'search_products',
    description:
      'Search the business catalog by name (or get all products with an empty query). Use to answer "what do you sell", "do you have X", and to present options with prices. Products include available stock.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: prop('string', 'Partial product name to search for. Empty means list all.'),
      },
    },
  },
  {
    name: 'get_product',
    description: 'Get full details (description, price, stock) for one product by its exact id.',
    parameters: {
      type: 'OBJECT',
      properties: { id: prop('string', 'Exact product id from search_products') },
      required: ['id'],
    },
  },
  {
    name: 'get_stock',
    description:
      'Check current stock for one product by its SKU. Use when a customer asks "is X available" or about quantities.',
    parameters: {
      type: 'OBJECT',
      properties: { sku: prop('string', 'Product SKU') },
      required: ['sku'],
    },
  },
  {
    name: 'add_to_cart',
    description:
      'Add a product (by its id from search_products/get_product) to the customer\'s cart. Quantity defaults to 1. Use to build up an order before confirming.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_id: prop('string', 'Exact product id from search_products'),
        quantity: prop('integer', 'How many to add (default 1)'),
      },
      required: ['product_id'],
    },
  },
  {
    name: 'view_cart',
    description: 'Read the customer\'s current cart (items, quantities, unit prices, total). Use before confirming an order.',
    parameters: { type: 'OBJECT', properties: {} },
  },
  {
    name: 'create_order',
    description:
      'Create a draft order for the customer. Call ONLY after the customer has confirmed items AND quantity. Omit "items" to place the order from the current cart. Never invent products — use ids from search_products/get_product. Returns the order id, status DRAFT, and total.',
    parameters: {
      type: 'OBJECT',
      properties: {
        items: {
          type: 'array',
          description: 'Line items, each with product_id (string) and quantity (integer). Omit to place the cart.',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'Exact product id from search_products' },
              quantity: { type: 'integer', description: 'How many of this product' },
            },
            required: ['product_id', 'quantity'],
          },
        },
        note: prop('string', 'Optional order note (e.g. delivery address)'),
      },
    },
  },
  {
    name: 'get_order_status',
    description:
      'Check the status of an existing order (by its order id) for this customer. Returns status, total, payment status and payment link, delivery status and tracking reference, delivery address, and fulfilment date when present.',
    parameters: {
      type: 'OBJECT',
      properties: { order_id: prop('string', 'Order id') },
      required: ['order_id'],
    },
  },
  {
    name: 'create_payment_link',
    description:
      'Generate a secure Paystack payment link for a confirmed order (by its order id from create_order). Call right after the customer confirms the order. Returns the payment url to share with the customer. Never invent the amount — it is read from the order.',
    parameters: {
      type: 'OBJECT',
      properties: { order_id: prop('string', 'Order id from create_order') },
      required: ['order_id'],
    },
  },
  {
    name: 'update_order_address',
    description:
      "Update the delivery address of an existing order. Only allowed before the order is fulfilled, shipped, cancelled, or refunded. Use when a customer changes or corrects their delivery address.",
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: prop('string', 'Order id from get_order_status / create_order'),
        address: prop('string', 'The full new delivery address'),
      },
      required: ['order_id', 'address'],
    },
  },
  {
    name: 'escalate_to_human',
    description:
      'Hand off the conversation to a human. Call when the customer explicitly asks for a human, expresses frustration, asks something the agent is not confident about, or the request is out of scope (e.g. large refunds). The system will notify staff and reply that a human will take over.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: prop('string', 'Why the conversation is being escalated'),
        category: prop(
          'string',
          'Category of the escalation: angry_customer, refund_request, agent_uncertain, or out_of_scope',
        ),
      },
      required: ['reason'],
    },
  },
];

const HANDLERS: Record<string, (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>> = {
  search_products: searchProducts,
  get_product: getProduct,
  get_stock: getStock,
  add_to_cart: addToCart,
  view_cart: viewCart,
  create_order: createOrder,
  get_order_status: getOrderStatus,
  create_payment_link: createPaymentLink,
  update_order_address: updateOrderAddress,
  escalate_to_human: escalateToHuman,
};

export const TOOLS: AgentTool[] = TOOL_DEFS.map((def) => ({ ...def, handler: HANDLERS[def.name] }));

export function toGeminiDeclarations(tools: AgentTool[] = TOOLS): GeminiFunctionDeclaration[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) as GeminiFunctionDeclaration[];
}

export function findTool(name: string): AgentTool | undefined {
  return TOOLS.find((t) => t.name === name);
}