import { describe, expect, it } from 'vitest';
import { buildAgentPrompt, buildSystemPrompt, type AgentRole } from '../src/prompt';

const ROLES: AgentRole[] = ['sales', 'support', 'logistics'];

describe('buildAgentPrompt — one brand voice across all agents', () => {
  it('shares the identical voice/grounding sections across every role', () => {
    const prompts = ROLES.map((role) => buildAgentPrompt({ businessName: 'Test Shop', currency: 'NGN', role }));
    const [first] = prompts;

    for (const prompt of prompts.slice(1)) {
      expect(prompt).toContain('ONE ongoing conversation');
      expect(prompt).toContain('the SAME single assistant');
      expect(prompt).toContain('## Tone');
      expect(prompt).toContain('## Grounding (most important rule)');
      expect(prompt).toContain('## Pricing');
      expect(prompt).toContain('## Handoff / escalation');
      expect(prompt).toContain('## Never');
      expect(prompt).toContain('## Voice notes');
    }
    // The shared block (up to the role section) must be byte-identical.
    for (const prompt of prompts.slice(1)) {
      expect(prompt.split('## Your focus')[0]).toBe(first.split('## Your focus')[0]);
    }
  });

  it('gives each role its own focus section', () => {
    expect(buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'sales' })).toContain(
      'Your focus: products, pricing, and orders',
    );
    expect(buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'support' })).toContain(
      'Your focus: complaints, returns, and order issues',
    );
    expect(buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'logistics' })).toContain(
      'Your focus: delivery',
    );
  });

  it('bakes the refund threshold into the support prompt only', () => {
    const support = buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'support', refundThreshold: 75000 });
    expect(support).toContain('75000');
    const sales = buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'sales', refundThreshold: 75000 });
    expect(sales).not.toContain('75000');
  });

  it('keeps buildSystemPrompt as the sales specialization (backward compat)', () => {
    const sales = buildAgentPrompt({ businessName: 'Shop', currency: 'NGN', role: 'sales' });
    const legacy = buildSystemPrompt({ businessName: 'Shop', currency: 'NGN' });
    expect(legacy).toBe(sales);
  });

  it('gives the sales agent the conversational-psychology guidance', () => {
    const sales = buildAgentPrompt({ businessName: 'S', currency: 'NGN', role: 'sales' });
    expect(sales).toContain('## Conversational psychology');
    expect(sales).toContain('### Acknowledge before you counter');
    expect(sales).toContain('### Show, don\'t claim');
    expect(sales).toContain('### Helpful comparison');
    expect(sales).toContain('### Warmth');
    expect(sales).toContain('### Hard boundaries — never cross these');
    expect(sales).toContain('### Before / after examples');
    expect(sales).toContain('### Principle tag');
    expect(sales).toContain('[principle: none]');
    expect(sales).toContain('[principle: tactical_empathy]');
    expect(sales).toContain('[principle: anchoring]');
  });

  it('does not leak sales psychology into support/logistics prompts', () => {
    for (const role of ['support', 'logistics'] as const) {
      const prompt = buildAgentPrompt({ businessName: 'S', currency: 'NGN', role });
      expect(prompt).not.toContain('## Conversational psychology');
      expect(prompt).not.toContain('[principle:');
    }
  });
});