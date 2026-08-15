import { describe, expect, it, vi } from 'vitest';
import { SalesAgent, buildContents, type AgentTurn } from '../src/agent';
import { buildSystemPrompt, formatMoney } from '../src/prompt';
import type { GeminiLike, GeminiResult } from '../src/types';
import type { GeminiTurn } from '../src/client';
import type { AuditService } from '../../audit/src';
import { createLogger } from '../../shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

class FakeLlm implements GeminiLike {
  calls = 0;
  constructor(private readonly responses: Array<GeminiResult | (() => GeminiResult)>) {}

  async generate(): Promise<GeminiResult> {
    const r = this.responses[Math.min(this.calls, this.responses.length - 1)];
    this.calls += 1;
    return typeof r === 'function' ? r() : r;
  }
}

const product = (id: string, name: string, price: number) => ({
  id,
  name,
  description: `${name} description`,
  price,
  currency: 'NGN',
  category: 'Groceries',
  sku: `SKU-${id}`,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  stockLevels: [{ quantity: 20, reserved: 0, productId: id, id: `sl-${id}`, updatedAt: new Date() }],
});

function makePrisma(products: ReturnType<typeof product>[] = []) {
  return {
    business: {
      findUnique: vi.fn(async () => ({ id: 'biz-1', name: 'Test Shop', currency: 'NGN' })),
    },
    conversation: {
      findUnique: vi.fn(async (): Promise<{ id: string; metadata: unknown }> => ({ id: 'conv-1', metadata: null })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'conv-1', ...data })),
    },
    product: {
      findMany: vi.fn(async ({ where }: { where?: { name?: { contains: string } } } = {}) => {
        const query = where?.name?.contains?.toLowerCase();
        return products.filter((p) => !query || p.name.toLowerCase().includes(query));
      }),
      findFirst: vi.fn(async ({ where }: { where?: { id?: string } } = {}) =>
        products.find((p) => p.id === where?.id) ?? null,
      ),
    },
    order: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'order-1', ...data })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makePrisma(products))),
  };
}

function makeAgent(llm: GeminiLike, prisma: ReturnType<typeof makePrisma>, maxToolRounds?: number) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  return {
    agent: new SalesAgent({ llm, prisma: prisma as never, audit, logger: silentLogger, maxToolRounds }),
    audit,
  };
}

const input = {
  businessId: 'biz-1',
  customerId: 'cust-1',
  customerWaId: '2348012345678',
  conversationId: 'conv-1',
  currency: 'NGN',
};

describe('SalesAgent', () => {
  it('returns a plain text reply when the model does not call a tool', async () => {
    const llm = new FakeLlm([{ text: 'Hi! Welcome to Test Shop. What can I get you today?', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Hello' }] });

    expect(reply.text).toContain('Welcome to Test Shop');
    expect(reply.escalated).toBe(false);
    expect(reply.toolCalls).toEqual([]);
    expect(llm.calls).toBe(1);
  });

  it('executes a tool the model calls and continues to a final reply', async () => {
    const llm = new FakeLlm([
      { text: '', functionCalls: [{ name: 'search_products', args: { query: 'rice' } }] },
      { text: 'We have Royal Stallion Rice 50kg at ₦85,000. Would you like to order?', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, makePrisma([product('p1', 'Royal Stallion Rice 50kg', 85000)]));
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Do you sell rice?' }] });

    expect(reply.text).toContain('Royal Stallion Rice 50kg');
    expect(reply.toolCalls).toEqual(['search_products']);
    expect(llm.calls).toBe(2);
  });

  it('flags escalation when the model calls escalate_to_human and records the reason', async () => {
    const llm = new FakeLlm([
      { text: '', functionCalls: [{ name: 'escalate_to_human', args: { reason: 'customer asked for a human' } }] },
      { text: 'I am connecting you with a human representative.', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'I want to speak to a person' }] });

    expect(reply.escalated).toBe(true);
    expect(reply.escalationReason).toBe('customer asked for a human');
    expect(reply.toolCalls).toContain('escalate_to_human');
  });

  it('stops the tool loop at maxToolRounds and returns the fallback reply', async () => {
    const llm = new FakeLlm([
      () => ({ text: '', functionCalls: [{ name: 'search_products', args: {} }] }),
    ]);
    const { agent } = makeAgent(llm, makePrisma([product('p1', 'Rice', 85000)]), 3);
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Hi' }] });

    expect(llm.calls).toBe(3);
    expect(reply.text.length).toBeGreaterThan(0);
    expect(reply.toolCalls.length).toBe(3);
  });

  it('feeds an unknown tool result back to the model without crashing', async () => {
    const llm = new FakeLlm([
      { text: '', functionCalls: [{ name: 'totally_unknown_tool', args: {} }] },
      { text: 'Sorry, I do not understand yet.', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Hi' }] });

    expect(reply.text).toBe('Sorry, I do not understand yet.');
    expect(reply.toolCalls).toEqual([]);
  });

  it('loads a persisted cart from conversation metadata', async () => {
    const prisma = makePrisma([product('p1', 'Rice 50kg', 85000)]);
    prisma.conversation.findUnique.mockResolvedValueOnce({
      id: 'conv-1',
      metadata: { cart: { items: [{ productId: 'p1', productName: 'Rice 50kg', sku: null, unitPrice: 85000, quantity: 2, total: 170000 }] } },
    });
    const llm = new FakeLlm([
      { text: '', functionCalls: [{ name: 'add_to_cart', args: { product_id: 'p1', quantity: 3 } }] },
      { text: 'Now 5x Rice in your cart.', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, prisma);
    await agent.run({ ...input, history: [{ role: 'user', text: 'Add 3 more bags' }] });

    const updateCall = prisma.conversation.update.mock.calls[0][0] as {
      data: { metadata: { cart: { items: Array<{ quantity: number }> } } };
    };
    expect(updateCall.data.metadata.cart.items[0].quantity).toBe(5);
  });

  it('persists cart changes back to the conversation metadata', async () => {
    const prisma = makePrisma([product('p1', 'Rice 50kg', 85000)]);
    const llm = new FakeLlm([
      { text: '', functionCalls: [{ name: 'add_to_cart', args: { product_id: 'p1', quantity: 2 } }] },
      { text: 'Added 2x Rice 50kg. Anything else?', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, prisma);
    await agent.run({ ...input, history: [{ role: 'user', text: 'Add 2 bags of rice' }] });

    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: {
        metadata: expect.objectContaining({
          cart: expect.objectContaining({
            items: expect.arrayContaining([expect.objectContaining({ productId: 'p1', quantity: 2, total: 170000 })]),
          }),
        }),
      },
    });
  });

  it('does not persist when the cart is untouched', async () => {
    const prisma = makePrisma();
    const llm = new FakeLlm([{ text: 'Hi! How can I help you today?', functionCalls: [] }]);
    const { agent } = makeAgent(llm, prisma);
    await agent.run({ ...input, history: [{ role: 'user', text: 'Hello' }] });

    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it('handles a CLEAR voice note: transcription flows as the user turn (no directive)', async () => {
    const llm = new FakeLlm([{ text: 'Rice 50kg is ₦85,000. How many bags?', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({
      ...input,
      history: [{ role: 'user', type: 'audio', transcription: 'ina bukatar rice 50kg' }],
      voiceNote: { text: 'ina bukatar rice 50kg', language: 'ha', confidence: 0.92, clear: true },
    });

    expect(reply.text).toContain('₦85,000');
    // No "could not be understood" directive was injected.
    expect(llm.calls).toBe(1);
  });

  it('handles an UNCLEAR voice note: injects an ask-to-repeat directive in the customer language', async () => {
    const llm = new FakeLlm([{ text: 'Yi haƙuri, ban ji maganarka ba. Don Allah ka sake maimaita.', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({
      ...input,
      history: [{ role: 'user', type: 'audio', transcription: '' }],
      voiceNote: { text: '', language: 'ha', confidence: 0.2, clear: false },
    });

    expect(reply.text).toContain('maimaita');
    expect(llm.calls).toBe(1);
    expect(reply.escalated).toBe(false);
  });

  it('uses a Pidgin label for an unclear Pidgin voice note', async () => {
    const llm = new FakeLlm([{ text: 'Sorry, I no hear you well. Abeg repeat.', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    await agent.run({
      ...input,
      history: [{ role: 'user', type: 'audio', transcription: '' }],
      voiceNote: { text: '', language: 'pcm', confidence: 0.1, clear: false },
    });
    expect(llm.calls).toBe(1);
  });

  it('buildContents prefers transcription over the audio placeholder', () => {
    const contents = buildContents([{ role: 'user', type: 'audio', transcription: 'na dey buy rice' }]);
    expect(contents[0].parts[0]).toEqual({ text: 'na dey buy rice' });
  });

  it('tags the model reply with its own sentiment and strips the marker before sending', async () => {
    const llm = new FakeLlm([
      { text: 'We have Royal Stallion Rice 50kg at ₦85,000.\n[sentiment: positive]', functionCalls: [] },
    ]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Thank you!' }] });

    expect(reply.sentiment).toBe('POSITIVE');
    expect(reply.text).toBe('We have Royal Stallion Rice 50kg at ₦85,000.');
    expect(reply.text).not.toContain('sentiment');
  });

  it('falls back to NEUTRAL sentiment when the model did not emit a marker', async () => {
    const llm = new FakeLlm([{ text: 'How can I help?', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Hi' }] });

    expect(reply.sentiment).toBe('NEUTRAL');
    expect(reply.text).toBe('How can I help?');
  });

  it('tags the applied principle and strips the marker before sending', async () => {
    const llm = new FakeLlm([
      {
        text: 'Sounds like that price feels steep right now.\n[sentiment: neutral]\n[principle: tactical_empathy]',
        functionCalls: [],
      },
    ]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Too expensive o' }] });

    expect(reply.principle).toBe('TACTICAL_EMPATHY');
    expect(reply.sentiment).toBe('NEUTRAL');
    expect(reply.text).toBe('Sounds like that price feels steep right now.');
    expect(reply.text).not.toContain('principle');
    expect(reply.text).not.toContain('sentiment');
  });

  it('falls back to NONE principle when the model did not tag one', async () => {
    const llm = new FakeLlm([{ text: 'We have it in stock.', functionCalls: [] }]);
    const { agent } = makeAgent(llm, makePrisma());
    const reply = await agent.run({ ...input, history: [{ role: 'user', text: 'Hi' }] });

    expect(reply.principle).toBe('NONE');
    expect(reply.text).toBe('We have it in stock.');
  });

  it("acknowledges the customer's category answer instead of re-asking the same question", async () => {
    let seenLastTurn = '';
    const llm = {
      generate: vi.fn(async (opts: { contents: GeminiTurn[]; systemInstruction: string; tools: unknown }) => {
        const last = opts.contents[opts.contents.length - 1];
        seenLastTurn = last.parts.map((p) => (p as { text?: string }).text ?? '').join(' ');
        return { text: 'Great — you chose chairs. Here are our chair options.\n[sentiment: positive]\n[principle: none]', functionCalls: [] };
      }),
    } as unknown as GeminiLike;
    const { agent } = makeAgent(llm, makePrisma());

    const reply = await agent.run({
      ...input,
      history: [
        { role: 'user', text: 'Me kuke dashi?' },
        { role: 'model', text: 'Which category — chairs, carpets, or decor?' },
        { role: 'user', text: 'Kujera' },
      ],
    });

    // The model received the customer's actual answer as its final input...
    expect(seenLastTurn).toContain('Kujera');
    // ...and the reply acknowledges that specific answer, not a generic re-ask.
    expect(reply.text).toContain('chairs');
  });

  it('keeps full prior context across a multi-hour gap (no reset to a fresh greeting)', async () => {
    let receivedTurns: string[] = [];
    const llm = {
      generate: vi.fn(async (opts: { contents: GeminiTurn[]; systemInstruction: string; tools: unknown }) => {
        receivedTurns = opts.contents.map((c) => c.parts.map((p) => (p as { text?: string }).text ?? '').join(' '));
        return { text: 'Welcome back — you were asking about our products.\n[sentiment: neutral]\n[principle: none]', functionCalls: [] };
      }),
    } as unknown as GeminiLike;
    const { agent } = makeAgent(llm, makePrisma());

    const reply = await agent.run({
      ...input,
      history: [
        { role: 'user', text: 'Hy' },
        { role: 'model', text: 'Welcome to NAYAYA & CO.' },
        { role: 'user', text: 'Me kuke dashi?' },
        { role: 'model', text: 'We sell furniture, carpets, electronics, flowers, decor.' },
        { role: 'user', text: 'Hy' },
      ],
    });

    // Every prior turn — including hours-old context — reaches the model.
    expect(receivedTurns).toEqual([
      'Hy',
      'Welcome to NAYAYA & CO.',
      'Me kuke dashi?',
      'We sell furniture, carpets, electronics, flowers, decor.',
      'Hy',
    ]);
    // The reply continues the conversation instead of restarting with a greeting.
    expect(reply.text).toContain('you were asking about our products');
  });
});

describe('buildContents', () => {
  it('maps INBOUND to user and OUTBOUND to model roles', () => {
    const contents = buildContents([
      { role: 'user', text: 'Hi', type: 'text' },
      { role: 'model', text: 'Hello!', type: 'text' },
      { role: 'user', text: 'Prices?', type: 'text' },
    ]);
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(contents[0].parts[0]).toEqual({ text: 'Hi' });
  });

  it('merges consecutive same-role turns and drops a leading model turn', () => {
    const contents = buildContents([
      { role: 'model', text: 'orphaned outbound', type: 'text' },
      { role: 'user', text: 'a', type: 'text' },
      { role: 'model', text: 'b', type: 'text' },
      { role: 'model', text: 'c', type: 'text' },
    ]);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe('user');
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts).toEqual([{ text: 'b' }, { text: 'c' }]);
  });

  it('uses a placeholder for media-only messages', () => {
    const contents = buildContents([{ role: 'user', type: 'audio' }]);
    expect(contents[0].parts[0]).toEqual({ text: '[Voice note]' });
  });

  it('returns a Hello turn for an empty history', () => {
    const contents = buildContents([]);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }]);
  });

  it('skips turns with no text or placeholder', () => {
    const contents = buildContents([
      { role: 'user', type: 'unsupported-format' },
      { role: 'user', text: '  ', type: 'text' },
      { role: 'user', text: 'real', type: 'text' },
    ]);
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'real' }] }]);
  });
});

describe('prompt helpers', () => {
  it('builds a system prompt mentioning the business and currency', () => {
    const prompt = buildSystemPrompt({ businessName: 'Acme Mart', currency: 'NGN' });
    expect(prompt).toContain('Acme Mart');
    expect(prompt).toContain('NGN');
    expect(prompt).toContain('escalate_to_human');
  });

  it('formats money with the currency', () => {
    expect(formatMoney(5000, 'NGN')).toMatch(/₦/);
    expect(formatMoney(5000, 'NGN')).toContain('5,000');
  });
});

export type { AgentTurn };