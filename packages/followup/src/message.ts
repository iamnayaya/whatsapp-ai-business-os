import { formatMoney } from '../../ai/src/prompt';

/**
 * A cart line as persisted in `Conversation.metadata.cart.items`.
 */
export interface FollowUpCartItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface BuildFollowUpMessageInput {
  businessName: string;
  /** Customer's name (or profile name) — used for a friendly greeting. */
  customerName?: string | null;
  items: FollowUpCartItem[];
  /** 1-based follow-up attempt number (1 = first nudge, 2 = last chance). */
  attempt: number;
  currency: string;
}

/** "2x Rice 50kg" / "2x Rice 50kg and 1x Palm Oil 5L" / "a, b and c". */
export function describeItems(items: FollowUpCartItem[]): string {
  const parts = items.map((i) => `${i.quantity}x ${i.productName}`);
  if (parts.length === 0) return 'your cart';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function greeting(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? `Hi ${first}! ` : '';
}

/**
 * Builds the WhatsApp message for one follow-up. Always references the exact
 * items the customer had in their cart (never a generic "are you still
 * there?"). Attempt 1 is a warm nudge; attempt 2 is softer and leaves the
 * door open. Never promises delivery/discounts.
 */
export function buildFollowUpMessage(input: BuildFollowUpMessageInput): string {
  const items = describeItems(input.items);
  const total = input.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const money = formatMoney(total, input.currency);
  const greet = greeting(input.customerName);

  if (input.attempt <= 1) {
    return (
      `${greet}You were checking out ${items} for ${money} — no pressure at all, ` +
      `they're still available if you'd like to go ahead. ` +
      `Reply to place your order, or just ask me anything.`
    );
  }

  return (
    `${greet}Just leaving the door open on ${items} — whenever you're ready, ` +
    `reply and I'll be glad to get your order sorted. No rush at all.`
  );
}

export interface BuildPaymentFollowUpInput {
  businessName: string;
  customerName?: string | null;
  orderId: string;
  total: number;
  currency: string;
  paymentUrl: string;
  attempt: number;
}

/**
 * Follow-up for an order whose payment never completed. Always includes the
 * fresh payment link so the customer can act immediately, and names the order
 * + amount so it is unambiguous which checkout this refers to.
 */
export function buildPaymentFollowUpMessage(input: BuildPaymentFollowUpInput): string {
  const money = formatMoney(input.total, input.currency);
  const greet = greeting(input.customerName);
  const ref = input.orderId.slice(0, 8).toUpperCase();

  if (input.attempt <= 1) {
    return (
      `${greet}Looks like the payment for your order (${ref}) of ${money} didn't go through. ` +
      `No problem at all — here's the link to complete it: ${input.paymentUrl}`
    );
  }

  return (
    `${greet}Just checking in — your order (${ref}) of ${money} is still waiting on payment. ` +
    `Tap this link whenever you're ready: ${input.paymentUrl}`
  );
}