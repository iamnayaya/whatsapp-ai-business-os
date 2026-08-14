import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../packages/db/src';
import { createLogger, ESCALATION_STATUS, ORDER_STATUS } from '../../packages/shared/src';
import { createAuditService, type AuditService } from '../../packages/audit/src';
import { AgentOrchestrator } from '../../packages/ai/src';
import { MessageRouter } from '../../packages/ai/src';
import type { AgentTurn, AgentReply } from '../../packages/ai/src';
import type { GeminiLike, GeminiResult } from '../../packages/ai/src';
import { mixedScenarios, ROLE_PROMPT_MARKERS } from '../../packages/ai/test/mixed-scenarios';

/**
 * Phase 6 integration tests: the 5 mixed multi-agent conversations run against
 * real Postgres (Testcontainers) with a scripted LLM. Each conversation routes
 * mid-thread between specialized agents over one shared history and persists
 * real side effects (orders, delivery-address changes, escalation rows).
 */

let prisma: PrismaClient;
let audit: AuditService;
let seededOrderId = '';
let riceProductId = '';
const logger = createLogger('multi-agent');
const TS = String(Math.floor(Date.now() / 1000));
const PNID = 'MA_PNID';
const WA_ID = `2349${String(Date.now()).slice(-9)}`;

class ScriptedLlm implements GeminiLike {
  queue: GeminiResult[] = [];
  instructions: string[] = [];

  async generate(opts: { systemInstruction?: string }): Promise<GeminiResult> {
    this.instructions.push(opts.systemInstruction ?? '');
    const next = this.queue.shift();
    if (!next) throw new Error('scripted LLM queue exhausted');
    return next;
  }

  setScript(entries: GeminiResult[]) {
    this.queue = [...entries];
  }
}

beforeAll(async () => {
  prisma = createPrismaClient();
  audit = createAuditService({ prisma, logger });

  // Wipe leftovers from a previous run, then seed the shop.
  await prisma.escalation.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.stockLevel.deleteMany({ where: { product: { business: { phoneNumber: PNID } } } }).catch(() => undefined);
  await prisma.product.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);
  await prisma.customer.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);

  const business = await prisma.business.create({
    data: { name: 'Multi-Agent Shop', phoneNumber: PNID, currency: 'NGN' },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, waId: WA_ID, name: 'Multi-Agent Tester' },
  });
  await prisma.conversation.create({
    data: { businessId: business.id, customerId: customer.id, status: 'OPEN' },
  });

  const rice = await prisma.product.create({
    data: {
      id: 'ma-product-rice',
      name: 'Royal Stallion Rice 50kg',
      sku: 'SKU-MA-RICE',
      price: 85000,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
      stockLevels: { create: { quantity: 40, reserved: 0 } },
    },
  });
  riceProductId = rice.id;
  await prisma.product.create({
    data: {
      id: 'ma-product-palm',
      name: 'Palm Oil 5L',
      sku: 'SKU-MA-PALM',
      price: 14500,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
      stockLevels: { create: { quantity: 40, reserved: 0 } },
    },
  });
  await prisma.product.create({
    data: {
      id: 'ma-product-eggs',
      name: 'Eggs Crate',
      sku: 'SKU-MA-EGGS',
      price: 12000,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
      stockLevels: { create: { quantity: 40, reserved: 0 } },
    },
  });

  const seeded = await prisma.order.create({
    data: {
      id: 'ma-seed-order',
      businessId: business.id,
      customerId: customer.id,
      status: ORDER_STATUS.PAID,
      subtotal: 170000,
      total: 170000,
      currency: 'NGN',
      deliveryAddress: 'Old address',
    },
  });
  seededOrderId = seeded.id;
});

afterAll(async () => {
  await prisma?.$disconnect();
});

async function runTurn(
  llm: ScriptedLlm,
  orchestrator: AgentOrchestrator,
  history: AgentTurn[],
  businessId: string,
  customerId: string,
  conversationId: string,
  text: string,
  script: GeminiResult[],
): Promise<AgentReply & { routedTo: string }> {
  llm.setScript(script);
  history.push({ role: 'user', text });
  const reply = await orchestrator.run({
    businessId,
    customerId,
    customerWaId: WA_ID,
    conversationId,
    history,
    currency: 'NGN',
  });
  if (reply.text.trim()) history.push({ role: 'model', text: reply.text });
  return reply;
}

describe('multi-agent integration — 5 mixed conversations against real Postgres', () => {
  it.each(mixedScenarios('ma-seed-order'))('$name', async (scenario) => {
    const business = await prisma.business.findUnique({ where: { phoneNumber: PNID } });
    const customer = await prisma.customer.findFirst({ where: { businessId: business!.id, waId: WA_ID } });
    const conversation = await prisma.conversation.create({
      data: { businessId: business!.id, customerId: customer!.id, status: 'OPEN' },
    });

    const llm = new ScriptedLlm();
    const orchestrator = new AgentOrchestrator({
      llm,
      prisma,
      audit,
      logger,
      router: new MessageRouter(),
    });
    const history: AgentTurn[] = [];

    for (const turn of scenario.turns) {
      const reply = await runTurn(llm, orchestrator, history, business!.id, customer!.id, conversation.id, turn.text, turn.script);
      expect(reply.routedTo).toBe(turn.expectedRoute);
      expect(llm.instructions.at(-1)).toContain(ROLE_PROMPT_MARKERS[turn.expectedRoute]);
      for (const tool of turn.expectTools ?? []) expect(reply.toolCalls).toContain(tool);
    }
  });

  it('persists an escalation queue row (REFUND_REQUEST, source support) for the damaged-bag conversation', async () => {
    const scenario = mixedScenarios('ma-seed-order')[0];
    const business = await prisma.business.findUnique({ where: { phoneNumber: PNID } });
    const customer = await prisma.customer.findFirst({ where: { businessId: business!.id, waId: WA_ID } });
    const conversation = await prisma.conversation.create({
      data: { businessId: business!.id, customerId: customer!.id, status: 'OPEN' },
    });

    const llm = new ScriptedLlm();
    const orchestrator = new AgentOrchestrator({ llm, prisma, audit, logger, router: new MessageRouter() });
    const history: AgentTurn[] = [];
    for (const turn of scenario.turns) {
      await runTurn(llm, orchestrator, history, business!.id, customer!.id, conversation.id, turn.text, turn.script);
    }

    const escalation = await prisma.escalation.findFirst({
      where: { conversationId: conversation.id },
    });
    expect(escalation).not.toBeNull();
    expect(escalation!.category).toBe('REFUND_REQUEST');
    expect(escalation!.sourceAgent).toBe('support');
    expect(escalation!.status).toBe(ESCALATION_STATUS.OPEN);
    expect(escalation!.reason).toContain('damaged');
  });

  it('persists the delivery-address change from the logistics agent', async () => {
    const scenario = mixedScenarios('ma-seed-order')[1];
    const business = await prisma.business.findUnique({ where: { phoneNumber: PNID } });
    const customer = await prisma.customer.findFirst({ where: { businessId: business!.id, waId: WA_ID } });
    const conversation = await prisma.conversation.create({
      data: { businessId: business!.id, customerId: customer!.id, status: 'OPEN' },
    });

    const llm = new ScriptedLlm();
    const orchestrator = new AgentOrchestrator({ llm, prisma, audit, logger, router: new MessageRouter() });
    const history: AgentTurn[] = [];
    for (const turn of scenario.turns) {
      await runTurn(llm, orchestrator, history, business!.id, customer!.id, conversation.id, turn.text, turn.script);
    }

    const order = await prisma.order.findUnique({ where: { id: seededOrderId } });
    expect(order!.deliveryAddress).toBe('24 Murtala Road');
  });

  it('places a real order mid-conversation (cart survives the route changes)', async () => {
    const scenario = mixedScenarios('ma-seed-order')[0];
    const business = await prisma.business.findUnique({ where: { phoneNumber: PNID } });
    const customer = await prisma.customer.findFirst({ where: { businessId: business!.id, waId: WA_ID } });
    const conversation = await prisma.conversation.create({
      data: { businessId: business!.id, customerId: customer!.id, status: 'OPEN' },
    });

    const llm = new ScriptedLlm();
    const orchestrator = new AgentOrchestrator({ llm, prisma, audit, logger, router: new MessageRouter() });
    const history: AgentTurn[] = [];
    // Drive only the first three turns (sales: browse -> cart -> confirm) and
    // capture the order id returned by the create_order tool.
    let createdOrderId = '';
    for (const turn of scenario.turns.slice(0, 3)) {
      const reply = await runTurn(llm, orchestrator, history, business!.id, customer!.id, conversation.id, turn.text, turn.script);
      if (reply.createdOrderId) createdOrderId = reply.createdOrderId;
    }

    expect(createdOrderId).not.toBe('');
    const order = await prisma.order.findUnique({ where: { id: createdOrderId }, include: { items: true } });
    expect(order).not.toBeNull();
    expect(order!.status).toBe(ORDER_STATUS.DRAFT);
    expect(Number(order!.total)).toBe(170000);
    expect(order!.items).toEqual([expect.objectContaining({ productId: riceProductId, quantity: 2 })]);
  });
});
