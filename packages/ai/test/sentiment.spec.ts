import { describe, expect, it } from 'vitest';
import { defaultSentiment, extractSentiment, parseSentiment } from '../src/sentiment';

describe('sentiment self-assessment (Phase 8)', () => {
  it('parses a marker on the end of the reply', () => {
    expect(parseSentiment('Rice 50kg is ₦85,000.\n[sentiment: positive]')).toBe('POSITIVE');
    expect(parseSentiment('Done!\n[sentiment: frustrated]')).toBe('FRUSTRATED');
    expect(parseSentiment('OK.\n[sentiment: neutral]')).toBe('NEUTRAL');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseSentiment('[Sentiment: POSITIVE]')).toBe('POSITIVE');
    expect(parseSentiment('[sentiment:   neutral  ]')).toBe('NEUTRAL');
  });

  it('extractSentiment strips the marker and trims the customer-facing text', () => {
    const { text, sentiment } = extractSentiment('Your order is confirmed.\n[sentiment: positive]\n');
    expect(text).toBe('Your order is confirmed.');
    expect(sentiment).toBe('POSITIVE');
  });

  it('returns the text unchanged and null sentiment when the model did not tag', () => {
    const { text, sentiment } = extractSentiment('Plain reply without a marker.');
    expect(text).toBe('Plain reply without a marker.');
    expect(sentiment).toBeNull();
  });

  it('defaultSentiment scores an angry escalation FRUSTRATED, everything else NEUTRAL', () => {
    expect(defaultSentiment(true, 'ANGRY_CUSTOMER')).toBe('FRUSTRATED');
    expect(defaultSentiment(true, 'REFUND_REQUEST')).toBe('NEUTRAL');
    expect(defaultSentiment(false, undefined)).toBe('NEUTRAL');
  });
});