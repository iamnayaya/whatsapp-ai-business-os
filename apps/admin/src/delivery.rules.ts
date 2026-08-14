import { DELIVERY_STATUS } from '../../../packages/shared/src';

/**
 * Manual delivery lifecycle (Phase 7): one-way transitions only.
 *
 *   PENDING -> PROCESSING -> SHIPPED -> DELIVERED
 */
export const DELIVERY_TRANSITIONS: Record<string, string[]> = {
  [DELIVERY_STATUS.PENDING]: [DELIVERY_STATUS.PROCESSING],
  [DELIVERY_STATUS.PROCESSING]: [DELIVERY_STATUS.SHIPPED],
  [DELIVERY_STATUS.SHIPPED]: [DELIVERY_STATUS.DELIVERED],
  [DELIVERY_STATUS.DELIVERED]: [],
};

/** Maps a CLI/user status string to its canonical constant, or undefined. */
export function normalizeDeliveryStatus(raw: string): string | undefined {
  const key = raw.trim().toUpperCase();
  if (key === 'PROCESSING') return DELIVERY_STATUS.PROCESSING;
  if (key === 'SHIPPED') return DELIVERY_STATUS.SHIPPED;
  if (key === 'DELIVERED') return DELIVERY_STATUS.DELIVERED;
  return undefined;
}

export function isValidDeliveryTransition(from: string, to: string): boolean {
  return DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextDeliveryStates(from: string): string[] {
  return DELIVERY_TRANSITIONS[from] ?? [];
}