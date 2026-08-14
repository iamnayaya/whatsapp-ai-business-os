import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator, categorizeEscalation, normalizeEscalationCategory, routingText } from '../src/orchestrator';
import type { AgentRunInput, AgentReply } from '../src/agent';
import type { GeminiLike, GeminiResult } from '../src/types';
import type { AuditService } from '../../audit/src';
import { createLogger } from '../../shared/src';
import { ESCALATION_CATEGORY, ESCALATION_STATUS } from '../../shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

const baseInput: AgentRunInput = {
  businessId: 'biz-1',
  customerId: 'cust-1',
  customerWaId: '2348012345678',
  conversationId: 'conv-1',
  history: [{ role: 'user', text: 'hello' }],
  currency: 'NGN',
};

const replyOf = (over: Partial<AgentReply>): AgentReply => ({
  text: 'ok',
  escalated: false,
  toolCalls: [],
  sentiment: 'NEUTRAL',
  principle: 'NONE',
  ...over,
});

function makeEscalationPrisma() {
  const escalations: unknown[] = [];
  const self = {
    escalation: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `esc-${escalations.length + 1}`, ...data };
        escalations.push(created);
        return created;
      }),
    },
    escalations,
  };
  return self;
}

describe('AgentOrchestrator', () => {
  it('dispatches to the routed agent with the shared history and reports routedTo', async () => {
    const sales = { run: vi.fn(async (input: AgentRunInput) => replyOf({ text: `saw ${input.history.length} turns` })) };
    const support = { run: vi.fn() };
    const logistics = { run: vi.fn() };
    const router = { route: vi.fn(async () => 'sales' as const) };
    const prisma = makeEscalationPrisma();
    const audit = { record: vi.fn() } as unknown as AuditService;
    const orchestrator = new AgentOrchestrator({
      llm: {} as GeminiLike,
      prisma: prisma as never,
      audit,
      logger: silentLogger,
      router: router as never,
      agents: { sales, support, logistics } as never,
    });

    const reply = await orchestrator.run({ ...baseInput, history: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' }] });

    expect(router.route).toHaveBeenCalledWith({ text: 'c', history: expect.any(Array) });
    expect(support.run).not.toHaveBeenCalled();
    expect(logistics.run).not.toHaveBeenCalled();
    expect(sales.run).toHaveBeenCalledOnce();
    expect(reply.routedTo).toBe('sales');
  });

  it('writes an escalation row with the category the agent passed', async () => {
    const support = {
      run: vi.fn(async () =>
        replyOf({ escalated: true, escalationReason: 'refund requested', escalationCategory: 'refund_request' }),
      ),
    };
    const prisma = makeEscalationPrisma();
    const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const orchestrator = new AgentOrchestrator({
      llm: {} as GeminiLike,
      prisma: prisma as never,
      audit,
      logger: silentLogger,
      router: { route: async () => 'support' as const },
      agents: { sales: { run: vi.fn() }, support, logistics: { run: vi.fn() } } as never,
    });

    const reply = await orchestrator.run(baseInput);

    expect(reply.routedTo).toBe('support');
    expect(prisma.escalations).toHaveLength(1);
    expect(prisma.escalations[0]).toEqual(
      expect.objectContaining({
        conversationId: 'conv-1',
        reason: 'refund requested',
        category: ESCALATION_CATEGORY.REFUND_REQUEST,
        sourceAgent: 'support',
        status: ESCALATION_STATUS.OPEN,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ESCALATION_CREATED', entityType: 'ESCALATION' }),
    );
  });

  it('derives the category from the reason when the agent passed none', async () => {
    const support = {
      run: vi.fn(async () => replyOf({ escalated: true, escalationReason: 'customer is very angry and insulting' })),
    };
    const prisma = makeEscalationPrisma();
    const orchestrator = new AgentOrchestrator({
      llm: {} as GeminiLike,
      prisma: prisma as never,
      audit: { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
      logger: silentLogger,
      router: { route: async () => 'support' as const },
      agents: { sales: { run: vi.fn() }, support, logistics: { run: vi.fn() } } as never,
    });

    await orchestrator.run(baseInput);

    expect(prisma.escalations[0]).toEqual(
      expect.objectContaining({ category: ESCALATION_CATEGORY.ANGRY_CUSTOMER }),
    );
  });

  it('is idempotent: does not create a second escalation while one is OPEN', async () => {
    const support = {
      run: vi.fn(async () => replyOf({ escalated: true, escalationReason: 'refund requested' })),
    };
    const prisma = makeEscalationPrisma();
    prisma.escalation.findFirst.mockResolvedValueOnce({ id: 'existing-open' });
    const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const orchestrator = new AgentOrchestrator({
      llm: {} as GeminiLike,
      prisma: prisma as never,
      audit,
      logger: silentLogger,
      router: { route: async () => 'support' as const },
      agents: { sales: { run: vi.fn() }, support, logistics: { run: vi.fn() } } as never,
    });

    await orchestrator.run(baseInput);

    expect(prisma.escalation.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ESCALATION_CREATED' }));
  });

  it('builds real sales/support/logistics agents when none are injected', () => {
    const llm: GeminiLike = {
      generate: async () => ({ text: 'hi', functionCalls: [] }),
    } as unknown as GeminiLike;
    const prisma = {
      business: { findUnique: vi.fn(async () => ({ id: 'biz-1', name: 'Shop', currency: 'NGN' })) },
      conversation: { findUnique: vi.fn(async () => ({ id: 'conv-1', metadata: null })) },
    };
    const orchestrator = new AgentOrchestrator({
      llm,
      prisma: prisma as never,
      audit: { record: vi.fn() } as unknown as AuditService,
      logger: silentLogger,
    });

    expect(Object.keys(orchestrator.agents).sort()).toEqual(['logistics', 'sales', 'support']);
    expect(typeof orchestrator.router.route).toBe('function');
  });
});

describe('routingText', () => {
  it('uses the last user turn', () => {
    expect(
      routingText({
        ...baseInput,
        history: [{ role: 'user', text: 'hi' }, { role: 'model', text: 'welcome' }, { role: 'user', text: 'I want a refund' }],
      }),
    ).toBe('I want a refund');
  });

  it('prefers a clear voice transcription', () => {
    expect(
      routingText({
        ...baseInput,
        history: [{ role: 'user', text: 'old text' }],
        voiceNote: { text: 'where is my delivery', language: 'en', confidence: 0.9, clear: true },
      }),
    ).toBe('where is my delivery');
  });

  it('ignores an unclear voice note and falls back to the last user turn', () => {
    expect(
      routingText({
        ...baseInput,
        history: [{ role: 'user', text: 'where is my order' }],
        voiceNote: { text: '(unintelligible)', language: 'en', confidence: 0.3, clear: false },
      }),
    ).toBe('where is my order');
  });
});

describe('categorizeEscalation / normalizeEscalationCategory', () => {
  it('maps reason keywords to categories', () => {
    expect(categorizeEscalation('customer is angry and frustrated')).toBe(ESCALATION_CATEGORY.ANGRY_CUSTOMER);
    expect(categorizeEscalation('large refund request')).toBe(ESCALATION_CATEGORY.REFUND_REQUEST);
    expect(categorizeEscalation('I am not sure how to answer')).toBe(ESCALATION_CATEGORY.AGENT_UNCERTAIN);
    expect(categorizeEscalation('something random')).toBe(ESCALATION_CATEGORY.OTHER);
  });

  it('canonicalizes model-passed categories', () => {
    expect(normalizeEscalationCategory('refund_request')).toBe(ESCALATION_CATEGORY.REFUND_REQUEST);
    expect(normalizeEscalationCategory('ANGRY_CUSTOMER')).toBe(ESCALATION_CATEGORY.ANGRY_CUSTOMER);
    expect(normalizeEscalationCategory('out-of-scope')).toBe(ESCALATION_CATEGORY.OUT_OF_SCOPE);
    expect(normalizeEscalationCategory(undefined)).toBeUndefined();
    expect(normalizeEscalationCategory('totally_wrong')).toBeUndefined();
  });
});
