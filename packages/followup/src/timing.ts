/**
 * Pure follow-up timing rules. Everything takes an explicit `now` so the
 * clock can be mocked in tests without fake timers.
 */

export interface FollowUpConfig {
  /** Quiet before the first nudge (ms since the customer's last message). */
  firstDelayMs: number;
  /** Quiet before the final nudge (ms since the customer's last message). */
  secondDelayMs: number;
  /** Hard cap on how many follow-ups a single abandoned cart may receive. */
  maxAttempts: number;
  /** Quiet-hours window start (local hour, 0-23). */
  quietStartHour: number;
  /** Quiet-hours window end (local hour, 0-23). Equal to start = disabled. */
  quietEndHour: number;
}

export const FOLLOWUP_DEFAULT_CONFIG: FollowUpConfig = {
  firstDelayMs: 2 * 60 * 60 * 1000, // 2 hours
  secondDelayMs: 24 * 60 * 60 * 1000, // 24 hours
  maxAttempts: 2,
  quietStartHour: 21,
  quietEndHour: 9,
};

export type DueDecision =
  | { kind: 'not_due' }
  | { kind: 'due'; attempt: number }
  | { kind: 'capped' };

/**
 * Decides whether a follow-up is due for a cart that has gone quiet.
 * `sentAttempts` is how many follow-ups have already been attempted for this
 * conversation (any status — a failed send still counts, so the cap can never
 * be silently bypassed).
 *
 * @param now           current time (injected so tests can mock the clock)
 * @param lastActivityAt time of the customer's last inbound message
 * @param sentAttempts  prior follow-up attempts for this conversation
 */
export function decideFollowUp(now: Date, lastActivityAt: Date, sentAttempts: number, config: FollowUpConfig): DueDecision {
  if (sentAttempts >= config.maxAttempts) return { kind: 'capped' };

  const attempt = sentAttempts + 1;
  const delayMs = attempt === 1 ? config.firstDelayMs : config.secondDelayMs;
  const quietMs = now.getTime() - lastActivityAt.getTime();
  if (quietMs < delayMs) return { kind: 'not_due' };

  return { kind: 'due', attempt };
}

/** Local hour (0-23) of `now` in `timeZone`, using Intl (no library needed). */
export function hourInZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  return Number.isInteger(hour) ? hour % 24 : 0;
}

/**
 * True when `now` falls inside the quiet window in `timeZone`. The window
 * wraps across midnight by default (e.g. 21:00 -> 09:00 means the business
 * never texts late at night). Equal start/end hours disable the rule.
 */
export function isQuietHour(now: Date, timeZone: string, config: FollowUpConfig): boolean {
  const { quietStartHour, quietEndHour } = config;
  if (quietStartHour === quietEndHour) return false; // disabled
  const hour = hourInZone(now, timeZone);
  if (quietStartHour <= quietEndHour) {
    return hour >= quietStartHour && hour < quietEndHour;
  }
  return hour >= quietStartHour || hour < quietEndHour;
}