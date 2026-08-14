import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../src/orchestrator';
import { MessageRouter } from '../src/router';
import type { AgentTurn } from '../src/agent';
import type { GeminiLike, GeminiResult } from '../src/types';
import type { AuditService } from '../../audit/src';
import { createLogger } from '../../shared/src';
import { ESCALATION_CATEGORY, ESCALATION_STATUS } from '../../shared/src';
import { mixedScenarios, ROLE_PROMPT_MARKERS } from './mixed-scenarios';

const silentLogger = createLogger('test', { destination: () => undefined });

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

const product = (id: string, name: string, price: number) => ({
  id,
  name,
  description: `${name} description`,
  price,
  currency: 'NGN',
  category: 'Groceries',
  sku: `SKU-${id}`,
  isActive: true,
  stockLevels: [{ quantity: 40, reserved: 0 }],
});

const order = {
  id: 'o1',
  status: 'PAID',
  subtotal: 170000,
  total: 170000,
  currency: 'NGN',
  createdAt: new Date('2026-01-02T00:00:00Z'),
  deliveryAddress: 'Old address',
  fulfilledAt: null,
  notes: null,
  payments: [{ status: 'SUCCESS' }],
};

function makePrisma() {
  const products = [product('p-rice', 'Royal Stallion Rice 50kg', 85000), product('p-palm', 'Palm Oil 5L', 14500), product('p-eggs', 'Eggs Crate', 12000)];
  const escalations: unknown[] = [];
  let convMeta: unknown = null;
  const self = {
    business: {
      findUnique: vi.fn(async () => ({ id: 'biz-1', name: 'Test Shop', currency: 'NGN' })),
    },
    conversation: {
      findUnique: vi.fn(async () => ({ id: 'conv-1', metadata: convMeta })),
      update: vi.fn(async ({ data }: { data: { metadata: unknown } }) => {
        convMeta = data.metadata;
        return { id: 'conv-1', ...data };
      }),
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
      findFirst: vi.fn(async () => order),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...order,
        ...data,
      })),
    },
    followUp: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    escalation: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `esc-${escalations.length + 1}`;
        const created = { id, ...data };
        escalations.push(created);
        return created;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(self)),
    escalations,
  };
  return self;
}

interface Harness {
  llm: ScriptedLlm;
  prisma: ReturnType<typeof makePrisma>;
  orchestrator: AgentOrchestrator;
}

function makeHarness(conversationId: string): Harness {
  const llm = new ScriptedLlm();
  const prisma = makePrisma();
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  // Heuristic-only router: routing never consumes the scripted LLM responses.
  const orchestrator = new AgentOrchestrator({
    llm,
    prisma: prisma as never,
    audit,
    logger: silentLogger,
    router: new MessageRouter(),
  });
  return { llm, prisma, orchestrator };
}

async function runTurn(h: Harness, history: AgentTurn[], conversationId: string, text: string, script: GeminiResult[]) {
  h.llm.setScript(script);
  history.push({ role: 'user', text });
  const reply = await h.orchestrator.run({
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerWaId: '2348012345678',
    conversationId,
    history,
    currency: 'NGN',
  });
  if (reply.text.trim()) history.push({ role: 'model', text: reply.text });
  return reply;
}

describe('multi-agent orchestration — 5 mixed conversations', () => {
  it.each(mixedScenarios('o1'))('$name', async (scenario) => {
    const h = makeHarness(scenario.name);
    const history: AgentTurn[] = [];

    for (const turn of scenario.turns) {
      const reply = await runTurn(h, history, scenario.name, turn.text, turn.script);

      // The heuristic router picked the expected specialized agent.
      expect(reply.routedTo).toBe(turn.expectedRoute);
      // The agent that ran used ITS role prompt (proves dispatch, not just routing).
      expect(h.llm.instructions.at(-1)).toContain(ROLE_PROMPT_MARKERS[turn.expectedRoute]);
      if (turn.expectTools) {
        for (const tool of turn.expectTools) expect(reply.toolCalls).toContain(tool);
      }
    }
  });
});

describe('escalation queue writes from mixed conversations', () => {
  it('records a REFUND_REQUEST escalation sourced from the support agent', async () => {
    const scenario = mixedScenarios('o1')[0];
    const h = makeHarness('conv-escalation');
    const history: AgentTurn[] = [];
    for (const turn of scenario.turns) {
      await runTurn(h, history, 'conv-escalation', turn.text, turn.script);
    }

    expect(h.prisma.escalations).toHaveLength(1);
    expect(h.prisma.escalations[0]).toEqual(
      expect.objectContaining({
        conversationId: 'conv-escalation',
        category: ESCALATION_CATEGORY.REFUND_REQUEST,
        sourceAgent: 'support',
        status: ESCALATION_STATUS.OPEN,
      }),
    );
  });

  it('records an ANGRY_CUSTOMER escalation from the support agent', async () => {
    const scenario = mixedScenarios('o1')[3];
    const h = makeHarness('conv-angry');
    const history: AgentTurn[] = [];
    for (const turn of scenario.turns) {
      await runTurn(h, history, 'conv-angry', turn.text, turn.script);
    }

    expect(h.prisma.escalations).toHaveLength(1);
    expect(h.prisma.escalations[0]).toEqual(
      expect.objectContaining({
        conversationId: 'conv-angry',
        category: ESCALATION_CATEGORY.ANGRY_CUSTOMER,
        sourceAgent: 'support',
      }),
    );
  });
});
