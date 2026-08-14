import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../../packages/db/src';
import { createLogger, loadEnv, MESSAGE_DIRECTION, MESSAGE_STATUS, ORDER_STATUS } from '../../../packages/shared/src';
import { createAuditService, type AuditService } from '../../../packages/audit/src';
import {
  createWhatsappMessageQueue,
  createWhatsappMessageWorker,
  type Queue,
  type Worker,
} from '../../../packages/queue/src';
import { WebhookService } from '../src/webhook/webhook.service';
import { handleInboundMessage } from '../../worker/src/handler';
import { AgentOrchestrator, MessageRouter, type GeminiLike, type GeminiResult } from '../../../packages/ai/src';

/**
 * Full conversation flow against real Postgres + Redis + BullMQ:
 * greeting -> product browse -> add to cart -> order confirmation.
 * The LLM is scripted so the run is deterministic and offline; the WhatsApp
 * client is stubbed so nothing reaches the Meta API.
 */

let prisma: PrismaClient;
let queue: Queue;
let worker: Worker;
let service: WebhookService;
let audit: AuditService;
let riceProductId = '';

const logger = createLogger('conversation-flow');
const TS = String(Math.floor(Date.now() / 1000));
const PNID = 'FLOW_PNID';
const WA_ID = `2348${String(Date.now()).slice(-9)}`;

class ScriptedLlm implements GeminiLike {
  private queue: GeminiResult[] = [];
  generate(): Promise<GeminiResult> {
    const next = this.queue.shift();
    if (!next) throw new Error('scripted LLM queue exhausted');
    return Promise.resolve(next);
  }
  setScript(entries: GeminiResult[]) {
    this.queue = [...entries];
  }
}

const llm = new ScriptedLlm();
let outboundCounter = 0;

const stubWhatsapp = {
  sendText: async (_to: string, _body: string) => ({ waMessageId: `wamid.out.${++outboundCounter}` }),
};

function textPayload(waMessageId: string, body: string): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_FLOW',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: PNID },
              contacts: [{ profile: { name: 'Flow Tester' }, wa_id: WA_ID }],
              messages: [{ from: WA_ID, id: waMessageId, timestamp: TS, type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

async function waitForMessageStatus(waMessageId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const msg = await prisma.message.findUnique({ where: { waMessageId } });
    if (msg?.status === status) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${waMessageId} to reach ${status} (got ${msg?.status})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function findConversation(): Promise<{ id: string } | null> {
  return prisma.conversation.findFirst({ where: { business: { phoneNumber: PNID }, customer: { waId: WA_ID } } });
}

beforeAll(async () => {
  const env = loadEnv();
  prisma = createPrismaClient();
  audit = createAuditService({ prisma, logger });

  // Re-runnable: wipe any leftovers from a previous run.
  await prisma.agentAction.deleteMany({ where: { business: { phoneNumber: PNID } } }).catch(() => undefined);

  const business = await prisma.business.upsert({
    where: { phoneNumber: PNID },
    update: { name: 'Flow Test Shop' },
    create: { name: 'Flow Test Shop', phoneNumber: PNID, currency: 'NGN' },
  });
  const rice = await prisma.product.upsert({
    where: { id: 'flow-product-rice' },
    update: { name: 'Royal Stallion Rice 50kg', price: 85000, currency: 'NGN', businessId: business.id, isActive: true },
    create: {
      id: 'flow-product-rice',
      name: 'Royal Stallion Rice 50kg',
      sku: 'SKU-RICE-50',
      price: 85000,
      currency: 'NGN',
      businessId: business.id,
      isActive: true,
    },
  });
  await prisma.stockLevel.upsert({
    where: { productId: rice.id },
    update: { quantity: 20 },
    create: { productId: rice.id, quantity: 20, reserved: 0 },
  });
  riceProductId = rice.id;

  queue = createWhatsappMessageQueue({ url: env.REDIS_URL });
  // Heuristic-only router (no LLM fallback) so the scripted LLM queue is
  // consumed only by the sales agent, not by routing classifier calls.
  const agent = new AgentOrchestrator({ llm, prisma, audit, logger, router: new MessageRouter() });
  worker = createWhatsappMessageWorker({
    url: env.REDIS_URL,
    concurrency: 1,
    processor: (job) =>
      handleInboundMessage(job, {
        prisma,
        audit,
        logger,
        whatsapp: stubWhatsapp as never,
        agent,
        transcriber: { transcribe: async () => ({ text: '', language: 'unknown', confidence: 0, clear: false }) },
        killSwitch: { isActive: async () => false },
      }),
  });
  service = new WebhookService({ prisma, queue, audit, logger, config: env });
});

afterAll(async () => {
  await worker?.close();
  await queue?.close();
  await prisma?.$disconnect();
});

describe('end-to-end sales conversation (real agent + scripted LLM)', () => {
  it('greets, browses, carts, and places an order — cart survives across messages', async () => {
    // 1. Greeting — plain text, no tools.
    llm.setScript([{ text: 'Hi! Welcome to Flow Test Shop. What can I get you today?', functionCalls: [] }]);
    await service.handleWebhook(textPayload('wamid.flow.greeting', 'Hello'));
    await waitForMessageStatus('wamid.flow.greeting', MESSAGE_STATUS.PROCESSED);

    // 2. Product browse — search_products.
    llm.setScript([
      { text: '', functionCalls: [{ name: 'search_products', args: { query: 'rice' } }] },
      { text: 'We have Royal Stallion Rice 50kg at ₦85,000. Want me to add some to your cart?', functionCalls: [] },
    ]);
    await service.handleWebhook(textPayload('wamid.flow.browse', 'Do you sell rice?'));
    await waitForMessageStatus('wamid.flow.browse', MESSAGE_STATUS.PROCESSED);

    // 3. Add to cart — add_to_cart then view_cart, cart persisted to metadata.
    llm.setScript([
      { text: '', functionCalls: [{ name: 'add_to_cart', args: { product_id: riceProductId, quantity: 2 } }] },
      { text: '', functionCalls: [{ name: 'view_cart', args: {} }] },
      { text: 'Your cart has 2x Royal Stallion Rice 50kg = ₦170,000. Should I place the order?', functionCalls: [] },
    ]);
    await service.handleWebhook(textPayload('wamid.flow.cart', 'I want 2 bags of rice'));
    await waitForMessageStatus('wamid.flow.cart', MESSAGE_STATUS.PROCESSED);

    const conversation = await findConversation();
    expect(conversation).not.toBeNull();
    const convoWithMeta = await prisma.conversation.findUnique({
      where: { id: conversation!.id },
    });
    const meta = convoWithMeta?.metadata as { cart?: { items: Array<{ productId: string; quantity: number }> } };
    expect(meta?.cart?.items).toEqual([expect.objectContaining({ productId: riceProductId, quantity: 2 })]);

    // 4. Confirmation — create_order from cart, then cart cleared.
    llm.setScript([
      { text: '', functionCalls: [{ name: 'create_order', args: { note: 'Door 12, Ikeja' } }] },
      { text: 'Your order is placed! Order id confirmed below — total ₦170,000.', functionCalls: [] },
    ]);
    await service.handleWebhook(textPayload('wamid.flow.confirm', 'Yes, go ahead'));
    await waitForMessageStatus('wamid.flow.confirm', MESSAGE_STATUS.PROCESSED);

    const order = await prisma.order.findFirst({
      where: { business: { phoneNumber: PNID }, customer: { waId: WA_ID } },
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    });
    expect(order).not.toBeNull();
    expect(order!.status).toBe(ORDER_STATUS.DRAFT);
    expect(Number(order!.total)).toBe(170000);
    expect(order!.items).toEqual([expect.objectContaining({ productId: riceProductId, quantity: 2 })]);

    const cleared = await prisma.conversation.findUnique({ where: { id: conversation!.id } });
    const clearedMeta = cleared?.metadata as { cart?: { items: unknown[] } };
    expect(clearedMeta?.cart?.items).toEqual([]);

    const outbound = await prisma.message.count({ where: { conversationId: conversation!.id, direction: MESSAGE_DIRECTION.OUTBOUND } });
    expect(outbound).toBe(4);
  });
});
