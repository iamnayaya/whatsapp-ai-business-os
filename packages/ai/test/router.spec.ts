import { describe, expect, it } from 'vitest';
import { MessageRouter, classifyHeuristic, heuristicScore } from '../src/router';
import type { GeminiLike, GeminiResult } from '../src/types';

class FakeLlm implements GeminiLike {
  calls: Array<{ systemInstruction?: string; contents: unknown }> = [];
  constructor(private readonly responses: Array<{ text: string }>) {}
  async generate(opts: { systemInstruction?: string; contents: unknown }): Promise<GeminiResult> {
    this.calls.push(opts);
    const r = this.responses[Math.min(this.calls.length - 1, this.responses.length - 1)];
    return { text: r.text, functionCalls: [] };
  }
}

describe('classifyHeuristic', () => {
  it('routes buying/pricing messages to sales', () => {
    expect(classifyHeuristic('How much is a bag of rice?')).toBe('sales');
    expect(classifyHeuristic('Do you sell indomie?')).toBe('sales');
    expect(classifyHeuristic('I want to place an order for 2 crates')).toBe('sales');
    expect(classifyHeuristic('is rice in stock?')).toBe('sales');
  });

  it('routes complaints/returns/refunds to support', () => {
    expect(classifyHeuristic('I want a refund for my order')).toBe('support');
    expect(classifyHeuristic('the bag arrived damaged')).toBe('support');
    expect(classifyHeuristic('I want to return this item')).toBe('support');
    expect(classifyHeuristic('I want to speak to a real human')).toBe('support');
    expect(classifyHeuristic('this service is useless, worst shop ever')).toBe('support');
  });

  it('routes delivery/tracking/address questions to logistics', () => {
    expect(classifyHeuristic('Where is my order?')).toBe('logistics');
    expect(classifyHeuristic('When will my delivery arrive?')).toBe('logistics');
    expect(classifyHeuristic('Please change the delivery address')).toBe('logistics');
    expect(classifyHeuristic('is my delivery on the way?')).toBe('logistics');
  });

  it('breaks ties toward support over sales (a complaint about a product wins)', () => {
    expect(classifyHeuristic('the order was wrong, I am not happy')).toBe('support');
    expect(classifyHeuristic('my delivery is late')).toBe('logistics');
  });

  it('returns null when nothing matches', () => {
    expect(classifyHeuristic('')).toBeNull();
    expect(classifyHeuristic('ok thanks')).toBeNull();
    expect(classifyHeuristic('👍')).toBeNull();
  });

  it('scores by matched terms', () => {
    expect(heuristicScore('I want a refund for my order').support).toBeGreaterThan(0);
    expect(heuristicScore('I want a refund for my order').sales).toBeGreaterThan(0);
    expect(heuristicScore('Where is my order?').logistics).toBeGreaterThan(0);
  });
});

describe('MessageRouter', () => {
  it('defaults ambiguous messages to sales when no LLM is configured', async () => {
    const router = new MessageRouter();
    expect(await router.route({ text: 'ok thanks' })).toBe('sales');
  });

  it('uses the heuristic before the LLM fallback', async () => {
    const llm = new FakeLlm([{ text: '{"agent":"logistics"}' }]);
    const router = new MessageRouter({ llm });
    expect(await router.route({ text: 'I want a refund' })).toBe('support');
    expect(llm.calls).toHaveLength(0);
  });

  it('falls back to the LLM for ambiguous messages and parses its JSON', async () => {
    const llm = new FakeLlm([{ text: '```json\n{"agent":"logistics"}\n```' }]);
    const router = new MessageRouter({ llm });
    expect(await router.route({ text: 'hmm not sure' })).toBe('logistics');
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].systemInstruction).toContain('sales');
  });

  it('defaults to sales when the LLM returns unparseable output', async () => {
    const llm = new FakeLlm([{ text: 'I cannot route this right now' }]);
    const router = new MessageRouter({ llm });
    expect(await router.route({ text: '???' })).toBe('sales');
  });
});
