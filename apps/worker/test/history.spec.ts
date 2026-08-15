import { describe, expect, it, vi } from 'vitest';
import { loadHistory } from '../src/handler';
import { MESSAGE_DIRECTION } from '../../../packages/shared/src';

function makeMessage(
  i: number,
  sentAt: Date,
  opts: { direction?: string; text?: string | null } = {},
) {
  return {
    id: `m${i}`,
    conversationId: 'conv-1',
    direction: opts.direction ?? MESSAGE_DIRECTION.INBOUND,
    type: 'text',
    text: opts.text ?? `message ${i}`,
    transcription: null,
    sentAt,
    createdAt: sentAt,
  };
}

function makePrisma(findMany: ReturnType<typeof vi.fn>) {
  return { message: { findMany } } as never;
}

describe('loadHistory', () => {
  it('returns the MOST RECENT messages in chronological order, up to the limit', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => makeMessage(i, new Date(`2026-08-15T00:${String(i).padStart(2, '0')}:00Z`)));
    const findMany = vi.fn().mockResolvedValue([...messages].reverse());

    const history = await loadHistory(makePrisma(findMany), 'conv-1');

    // The query orders newest-first with a generous limit (100) so ALL messages are returned.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: expect.arrayContaining([expect.objectContaining({ sentAt: 'desc' })]),
        take: 100,
      }),
    );
    // All 12 messages should be returned (limit is 100, not 10).
    expect(history).toHaveLength(12);
    // Order is chronological; the newest message is last.
    expect(history[0].text).toBe('message 0');
    expect(history[history.length - 1].text).toBe('message 11');
    expect(history.map((t) => t.text)).toEqual(Array.from({ length: 12 }, (_, i) => `message ${i}`));
  });

  it('keeps the full recent window across a multi-hour gap (no reset to a greeting)', async () => {
    const messages = [
      makeMessage(0, new Date('2026-08-15T00:21:00Z'), { text: 'Hy', direction: MESSAGE_DIRECTION.INBOUND }),
      makeMessage(1, new Date('2026-08-15T00:21:10Z'), { text: 'Welcome to NAYAYA & CO.', direction: MESSAGE_DIRECTION.OUTBOUND }),
      makeMessage(2, new Date('2026-08-15T00:22:00Z'), { text: 'Me kuke dashi?', direction: MESSAGE_DIRECTION.INBOUND }),
      makeMessage(3, new Date('2026-08-15T03:59:00Z'), { text: 'Hy again', direction: MESSAGE_DIRECTION.INBOUND }),
      makeMessage(4, new Date('2026-08-15T05:02:00Z'), { text: 'Hy later', direction: MESSAGE_DIRECTION.INBOUND }),
    ];
    const findMany = vi.fn().mockResolvedValue([...messages].reverse());

    const history = await loadHistory(makePrisma(findMany), 'conv-1');

    expect(history.map((t) => t.text)).toEqual([
      'Hy',
      'Welcome to NAYAYA & CO.',
      'Me kuke dashi?',
      'Hy again',
      'Hy later',
    ]);
    expect(history[history.length - 1]).toMatchObject({ role: 'user', text: 'Hy later' });
  });
});