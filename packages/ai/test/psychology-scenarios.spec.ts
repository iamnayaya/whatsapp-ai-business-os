import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../src/prompt';

const salesPrompt = () => buildAgentPrompt({ businessName: 'Test Shop', currency: 'NGN', role: 'sales' });

/**
 * Prompt-contract tests for the sales agent's conversational-psychology layer.
 * These assert that the system prompt instructs the right behavior for each
 * scenario (and the hard boundaries NOT to cross). Real model behavior needs a
 * live-LLM eval, which CI does not run — these are the offline contract.
 */
describe('sales conversational psychology — scenario contracts', () => {
  it('price objection: label the concern first, then an open question, with a Pidgin example', () => {
    const p = salesPrompt();
    expect(p).toContain('name the concern out loud');
    expect(p).toContain('What would make this work for you?');
    expect(p).toContain('Sounds like that price feels steep right now');
    expect(p).toContain('I dey hear you — di price dey a bit high for now');
    expect(p).toContain('Never answer a');
  });

  it('discount request: acknowledge first, then a real cheaper alternative, with a Hausa example', () => {
    const p = salesPrompt();
    expect(p).toContain("I hear you — you'd like it to cost less");
    expect(p).toContain('Na ji ka — kana son ya ragu');
    expect(p).toContain('never invent a discount');
    expect(p).toContain('Never promise discounts');
  });

  it('hesitant / quiet customer: calibrating open questions, no pressure, respect thinking time', () => {
    const p = salesPrompt();
    expect(p).toContain('open question that lets them steer');
    expect(p).toContain('Never pressure a customer who has clearly said no');
    expect(p).toContain('"let me think about it" is respected');
  });

  it('hard boundaries: no fabricated proof/scarcity, no withholding, no anchoring above a stated budget', () => {
    const p = salesPrompt();
    expect(p).toContain('Never fabricate scarcity, demand, reviews, or stock numbers');
    expect(p).toContain('Never withhold information');
    expect(p).toContain('Never use anchoring (higher-price-item-first) on a customer who has stated a firm budget');
    expect(p).toContain('never above a budget');
  });

  it('grounds social proof and scarcity in tool results only', () => {
    const p = salesPrompt();
    expect(p).toContain('only when a tool result confirms it');
    expect(p).toContain('only real stock from the database');
    expect(p).toContain('Fabricated urgency is a hard rule violation');
  });

  it('reads naturally in the customer language (Hausa/Pidgin/English, not a translated script)', () => {
    const p = salesPrompt();
    expect(p).toContain('Apply the principle in the customer\'s own words; never translate an English script word-for-word');
  });
});