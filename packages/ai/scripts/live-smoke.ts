import { GeminiClient } from '../src/client';
import { SalesAgent } from '../src/agent';
import { createLogger } from '../../shared/src/logger';

const logger = createLogger('live-smoke', { destination: () => undefined });
const key = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

if (!key) throw new Error('GEMINI_API_KEY env var missing');
const apiKey: string = key;

const fakePrisma = {
  business: { findUnique: async () => ({ id: 'biz-1', name: 'Smoke Test Shop', currency: 'NGN' }) },
  product: {
    findMany: async ({ where }: { where?: { name?: { contains: string } } } = {}) => {
      const q = where?.name?.contains?.toLowerCase();
      const all = [
        { id: 'p1', name: 'Royal Stallion Rice 50kg', price: 85000, currency: 'NGN', category: 'Groceries', description: '50kg bag of parboiled rice.', sku: 'RICE-50', isActive: true, stockLevels: [{ quantity: 40, reserved: 0 }] },
        { id: 'p2', name: 'Refined Palm Oil 5L', price: 14500, currency: 'NGN', category: 'Groceries', description: '5 litre bottle.', sku: 'PALM-5', isActive: true, stockLevels: [{ quantity: 60, reserved: 0 }] },
      ];
      return all.filter((p) => !q || p.name.toLowerCase().includes(q));
    },
    findFirst: async ({ where }: { where?: { id?: string } }) => {
      const all = [
        { id: 'p1', name: 'Royal Stallion Rice 50kg', price: 85000, currency: 'NGN', category: 'Groceries', description: '50kg bag of parboiled rice.', sku: 'RICE-50', isActive: true, stockLevels: [{ quantity: 40, reserved: 0 }] },
        { id: 'p2', name: 'Refined Palm Oil 5L', price: 14500, currency: 'NGN', category: 'Groceries', description: '5 litre bottle.', sku: 'PALM-5', isActive: true, stockLevels: [{ quantity: 60, reserved: 0 }] },
      ];
      return all.find((p) => p.id === where?.id) ?? null;
    },
  },
  order: {
    create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'order-smoke-1', ...data }),
    findFirst: async () => null,
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakePrisma),
} as never;

async function main(): Promise<void> {
  const llm = new GeminiClient({ apiKey, model, logger });
  const agent = new SalesAgent({ llm, prisma: fakePrisma, audit: { record: async () => undefined } as never, logger });

  console.log('=== 1) plain greeting ===');
  const t1 = await agent.run({
    businessId: 'biz-1', customerId: 'cust-1', customerWaId: '2348012345678', currency: 'NGN',
    history: [{ role: 'user', text: 'Hello', type: 'text' }],
  });
  console.log('reply:', JSON.stringify(t1));

  console.log('\n=== 2) catalog browse + order (real tool calls) ===');
  const t2 = await agent.run({
    businessId: 'biz-1', customerId: 'cust-1', customerWaId: '2348012345678', currency: 'NGN',
    history: [
      { role: 'user', text: 'Hello', type: 'text' },
      { role: 'model', text: 'Hi! Welcome to Smoke Test Shop. What can I get you today?', type: 'text' },
      { role: 'user', text: 'I want 2 bags of your 50kg rice and a 5 litre palm oil please.', type: 'text' },
    ],
  });
  console.log('reply:', JSON.stringify(t2));
  console.log('\ntools called:', JSON.stringify(t2.toolCalls), '| orderId:', t2.createdOrderId, '| escalated:', t2.escalated);

  console.log('\n=== 2b) order confirmation -> create_order ===');
  const t2b = await agent.run({
    businessId: 'biz-1', customerId: 'cust-1', customerWaId: '2348012345678', currency: 'NGN',
    history: [
      { role: 'user', text: 'I want 2 bags of your 50kg rice and a 5 litre palm oil please.', type: 'text' },
      { role: 'model', text: t2.text, type: 'text' },
      { role: 'user', text: 'Yes, that is correct. Go ahead and place it.', type: 'text' },
    ],
  });
  console.log('reply:', JSON.stringify(t2b));
  console.log('\ntools called:', JSON.stringify(t2b.toolCalls), '| orderId:', t2b.createdOrderId, '| escalated:', t2b.escalated);

  console.log('\n=== 3) escalation ===');
  const t3 = await agent.run({
    businessId: 'biz-1', customerId: 'cust-1', customerWaId: '2348012345678', currency: 'NGN',
    history: [{ role: 'user', text: 'I want to speak to a real human right now', type: 'text' }],
  });
  console.log('reply:', JSON.stringify(t3));
  console.log('escalated:', t3.escalated, '| reason:', t3.escalationReason);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE FAILED:', err?.message ?? err);
    if (err?.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  },
);
