import { describe, expect, it } from 'vitest';
import { decideFollowUp, isQuietHour, hourInZone, FOLLOWUP_DEFAULT_CONFIG, type FollowUpConfig } from '../src/timing';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

// Africa/Lagos is UTC+1 with no DST, so local times map trivially from UTC.
const LAGOS = 'Africa/Lagos';

function makeConfig(overrides: Partial<FollowUpConfig> = {}): FollowUpConfig {
  return { ...FOLLOWUP_DEFAULT_CONFIG, ...overrides };
}

describe('decideFollowUp (mocked clock)', () => {
  const lastActivity = new Date('2026-08-13T10:00:00.000Z');

  it('is not due yet before the first delay elapses', () => {
    const now = new Date(lastActivity.getTime() + TWO_HOURS - 1);
    expect(decideFollowUp(now, lastActivity, 0, makeConfig())).toEqual({ kind: 'not_due' });
  });

  it('is due for attempt 1 exactly at the first delay', () => {
    const now = new Date(lastActivity.getTime() + TWO_HOURS);
    expect(decideFollowUp(now, lastActivity, 0, makeConfig())).toEqual({ kind: 'due', attempt: 1 });
  });

  it('is due for attempt 2 only after the second (24h) delay', () => {
    const config = makeConfig();
    const before = new Date(lastActivity.getTime() + ONE_DAY - 1);
    expect(decideFollowUp(before, lastActivity, 1, config)).toEqual({ kind: 'not_due' });

    const at24h = new Date(lastActivity.getTime() + ONE_DAY);
    expect(decideFollowUp(at24h, lastActivity, 1, config)).toEqual({ kind: 'due', attempt: 2 });
  });

  it('caps at maxAttempts — a third nudge is never due', () => {
    const config = makeConfig({ maxAttempts: 2 });
    const farFuture = new Date(lastActivity.getTime() + 10 * ONE_DAY);
    expect(decideFollowUp(farFuture, lastActivity, 2, config)).toEqual({ kind: 'capped' });
  });

  it('uses configurable delays', () => {
    const config = makeConfig({ firstDelayMs: 30 * 60 * 1000, secondDelayMs: 60 * 60 * 1000 });
    const now = new Date(lastActivity.getTime() + 45 * 60 * 1000);
    expect(decideFollowUp(now, lastActivity, 0, config)).toEqual({ kind: 'due', attempt: 1 });
    expect(decideFollowUp(now, lastActivity, 1, config)).toEqual({ kind: 'not_due' });
    const later = new Date(lastActivity.getTime() + 90 * 60 * 1000);
    expect(decideFollowUp(later, lastActivity, 1, config)).toEqual({ kind: 'due', attempt: 2 });
  });

  it('treats a future lastActivityAt as not due (never negative timers)', () => {
    const now = new Date('2026-08-13T09:00:00.000Z');
    expect(decideFollowUp(now, lastActivity, 0, makeConfig())).toEqual({ kind: 'not_due' });
  });
});

describe('hourInZone', () => {
  it('converts UTC to the Lagos local hour (UTC+1)', () => {
    expect(hourInZone(new Date('2026-08-13T20:30:00.000Z'), LAGOS)).toBe(21);
    expect(hourInZone(new Date('2026-08-13T23:59:00.000Z'), LAGOS)).toBe(0);
    expect(hourInZone(new Date('2026-08-13T09:00:00.000Z'), LAGOS)).toBe(10);
  });
});

describe('isQuietHour (default 21:00 -> 09:00 local)', () => {
  const config = makeConfig({ quietStartHour: 21, quietEndHour: 9 });

  it('blocks after 9pm local', () => {
    expect(isQuietHour(new Date('2026-08-13T20:30:00.000Z'), LAGOS, config)).toBe(true); // 21:30 local
    expect(isQuietHour(new Date('2026-08-13T22:00:00.000Z'), LAGOS, config)).toBe(true); // 23:00 local
  });

  it('blocks before 9am local', () => {
    expect(isQuietHour(new Date('2026-08-13T07:00:00.000Z'), LAGOS, config)).toBe(true); // 08:00 local
    expect(isQuietHour(new Date('2026-08-13T05:30:00.000Z'), LAGOS, config)).toBe(true); // 06:30 local
  });

  it('allows sends during the day', () => {
    expect(isQuietHour(new Date('2026-08-13T09:00:00.000Z'), LAGOS, config)).toBe(false); // 10:00 local
    expect(isQuietHour(new Date('2026-08-13T15:00:00.000Z'), LAGOS, config)).toBe(false); // 16:00 local
    expect(isQuietHour(new Date('2026-08-13T19:59:00.000Z'), LAGOS, config)).toBe(false); // 20:59 local
  });

  it('is boundary-exact: 09:00 local is allowed, 08:59 and 21:00 local are not', () => {
    // 08:00:00 UTC = 09:00:00 local — exactly the end of the window: allowed.
    expect(isQuietHour(new Date('2026-08-13T08:00:00.000Z'), LAGOS, config)).toBe(false);
    // 07:59:59 UTC = 08:59:59 local — one second before 9am: still quiet.
    expect(isQuietHour(new Date('2026-08-13T07:59:59.000Z'), LAGOS, config)).toBe(true);
    // 20:00:00 UTC = 21:00:00 local — quiet.
    expect(isQuietHour(new Date('2026-08-13T20:00:00.000Z'), LAGOS, config)).toBe(true);
  });

  it('treats a non-wrapping window correctly', () => {
    const cfg = makeConfig({ quietStartHour: 2, quietEndHour: 5 });
    expect(isQuietHour(new Date('2026-08-13T03:00:00.000Z'), LAGOS, cfg)).toBe(true); // 04:00 local
    expect(isQuietHour(new Date('2026-08-13T08:00:00.000Z'), LAGOS, cfg)).toBe(false); // 09:00 local
  });

  it('is disabled when start === end', () => {
    const cfg = makeConfig({ quietStartHour: 0, quietEndHour: 0 });
    expect(isQuietHour(new Date('2026-08-13T03:00:00.000Z'), LAGOS, cfg)).toBe(false);
    expect(isQuietHour(new Date('2026-08-13T22:00:00.000Z'), LAGOS, cfg)).toBe(false);
  });

  it('respects a different business timezone', () => {
    // UTC+0 (e.g. Europe/London in winter). 22:00 UTC = 22:00 local -> quiet.
    expect(isQuietHour(new Date('2026-08-13T22:00:00.000Z'), 'UTC', config)).toBe(true);
    // Same instant in Lagos (23:00 local) is also quiet, but 13:00 UTC -> 14:00 Lagos is fine.
    expect(isQuietHour(new Date('2026-08-13T13:00:00.000Z'), 'UTC', config)).toBe(false);
  });
});