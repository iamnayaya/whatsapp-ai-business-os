import { describe, expect, it } from 'vitest';
import { defaultPrinciple, extractPrinciple, parsePrinciple } from '../src/principles';

describe('conversational-psychology self-tag (sales)', () => {
  it('parses a known principle marker', () => {
    expect(parsePrinciple('Ok, we have 2 left in this finish.\n[principle: scarcity]')).toBe('SCARCITY');
    expect(parsePrinciple('[principle: tactical_empathy]')).toBe('TACTICAL_EMPATHY');
    expect(parsePrinciple('[principle: rapport]')).toBe('RAPPORT');
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(parsePrinciple('[principle:   Anchoring  ]')).toBe('ANCHORING');
  });

  it('ignores unknown principle labels', () => {
    expect(parsePrinciple('[principle: telepathy]')).toBeNull();
  });

  it('returns null when no marker is present', () => {
    expect(parsePrinciple('Plain reply without a marker.')).toBeNull();
  });

  it('extractPrinciple strips the marker and trims the customer-facing text', () => {
    const { text, principle } = extractPrinciple(
      'Sounds like that price feels steep right now.\n[principle: tactical_empathy]\n',
    );
    expect(principle).toBe('TACTICAL_EMPATHY');
    expect(text).toBe('Sounds like that price feels steep right now.');
  });

  it('extractPrinciple leaves text unchanged and principle null when untagged', () => {
    const { text, principle } = extractPrinciple('We have it in stock.');
    expect(principle).toBeNull();
    expect(text).toBe('We have it in stock.');
  });

  it('defaults to NONE', () => {
    expect(defaultPrinciple()).toBe('NONE');
  });
});