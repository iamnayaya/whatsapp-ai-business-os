import { describe, expect, it } from 'vitest';
import { DELIVERY_STATUS } from '../../../packages/shared/src';
import { isValidDeliveryTransition, nextDeliveryStates, normalizeDeliveryStatus } from '../src/delivery.rules';

describe('delivery transition rules (Phase 7)', () => {
  it('allows only forward one-way transitions', () => {
    expect(isValidDeliveryTransition(DELIVERY_STATUS.PROCESSING, DELIVERY_STATUS.SHIPPED)).toBe(true);
    expect(isValidDeliveryTransition(DELIVERY_STATUS.SHIPPED, DELIVERY_STATUS.DELIVERED)).toBe(true);
    expect(isValidDeliveryTransition(DELIVERY_STATUS.PENDING, DELIVERY_STATUS.PROCESSING)).toBe(true);
  });

  it('rejects backwards and skipping transitions', () => {
    expect(isValidDeliveryTransition(DELIVERY_STATUS.SHIPPED, DELIVERY_STATUS.PROCESSING)).toBe(false);
    expect(isValidDeliveryTransition(DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.SHIPPED)).toBe(false);
    expect(isValidDeliveryTransition(DELIVERY_STATUS.PROCESSING, DELIVERY_STATUS.DELIVERED)).toBe(false);
    expect(isValidDeliveryTransition(DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.DELIVERED)).toBe(false);
  });

  it('normalizes user input to canonical statuses', () => {
    expect(normalizeDeliveryStatus('shipped')).toBe(DELIVERY_STATUS.SHIPPED);
    expect(normalizeDeliveryStatus(' PROCESSING ')).toBe(DELIVERY_STATUS.PROCESSING);
    expect(normalizeDeliveryStatus('delivered')).toBe(DELIVERY_STATUS.DELIVERED);
    expect(normalizeDeliveryStatus('shipped2')).toBeUndefined();
  });

  it('lists the allowed next states per current state', () => {
    expect(nextDeliveryStates(DELIVERY_STATUS.PROCESSING)).toEqual([DELIVERY_STATUS.SHIPPED]);
    expect(nextDeliveryStates(DELIVERY_STATUS.DELIVERED)).toEqual([]);
  });
});