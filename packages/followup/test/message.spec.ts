import { describe, expect, it } from 'vitest';
import { buildFollowUpMessage, describeItems, type FollowUpCartItem } from '../src/message';

const rice: FollowUpCartItem = { productId: 'p1', productName: 'Rice 50kg', quantity: 2, unitPrice: 85000 };
const oil: FollowUpCartItem = { productId: 'p2', productName: 'Palm Oil 5L', quantity: 1, unitPrice: 14500 };

describe('describeItems', () => {
  it('formats a single line', () => {
    expect(describeItems([rice])).toBe('2x Rice 50kg');
  });

  it('joins two lines with "and"', () => {
    expect(describeItems([rice, oil])).toBe('2x Rice 50kg and 1x Palm Oil 5L');
  });

  it('joins three or more with commas', () => {
    const soap: FollowUpCartItem = { productId: 'p3', productName: 'Soap Bar', quantity: 4, unitPrice: 2500 };
    expect(describeItems([rice, oil, soap])).toBe('2x Rice 50kg, 1x Palm Oil 5L and 4x Soap Bar');
  });

  it('falls back for an empty cart', () => {
    expect(describeItems([])).toBe('your cart');
  });
});

describe('buildFollowUpMessage', () => {
  const base = { businessName: 'Ahmad Nayaya', customerName: 'Amina', items: [rice, oil], attempt: 1, currency: 'NGN' };

  it('names the exact items and total in attempt 1 — never generic', () => {
    const msg = buildFollowUpMessage(base);
    expect(msg).toContain('Rice 50kg');
    expect(msg).toContain('Palm Oil 5L');
    expect(msg).toContain('2x Rice 50kg and 1x Palm Oil 5L');
    expect(msg).toContain('₦184,500');
    expect(msg).not.toContain('are you still there');
    expect(msg).not.toContain('still there');
  });

  it('greets the customer by first name', () => {
    expect(buildFollowUpMessage(base)).toMatch(/^Hi Amina!/);
  });

  it('is softer and leaves the door open on attempt 2', () => {
    const msg = buildFollowUpMessage({ ...base, attempt: 2 });
    expect(msg).toContain('Rice 50kg');
    expect(msg).toContain('No rush');
    expect(msg).not.toContain('₦184,500');
    expect(msg).not.toContain('no pressure at all');
  });

  it('does not reference the total in attempt 2', () => {
    const msg = buildFollowUpMessage({ ...base, attempt: 2 });
    expect(msg).not.toContain('184,500');
  });

  it('works without a customer name', () => {
    const msg = buildFollowUpMessage({ ...base, customerName: null });
    expect(msg).toContain('Rice 50kg');
    expect(msg).not.toContain('Hi !');
  });

  it('uses the configured currency', () => {
    const msg = buildFollowUpMessage({ ...base, currency: 'USD' });
    expect(msg).toContain('$');
  });
});