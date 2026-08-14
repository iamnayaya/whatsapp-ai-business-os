import { randomUUID } from 'crypto';
import { formatMoney } from '../../ai/src/prompt';

/** Short human-shareable tracking code, e.g. TRK-1F2E9A8B. */
export function generateTrackingReference(): string {
  return `TRK-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export interface ConfirmationLineItem {
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface BuildPaidConfirmationInput {
  businessName: string;
  customerName?: string | null;
  items: ConfirmationLineItem[];
  total: number;
  currency: string;
  trackingReference: string;
}

function firstName(name?: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0];
}

/**
 * The WhatsApp message sent the moment a payment is confirmed. Names the
 * tracking reference and the delivery lifecycle. Plain text (no emojis),
 * never promises dates.
 */
export function buildPaidConfirmation(input: BuildPaidConfirmationInput): string {
  const greet = firstName(input.customerName);
  const money = formatMoney(input.total, input.currency);
  const lines = input.items.map((i) => `${i.quantity}x ${i.productName}`).join(', ');
  const header = greet ? `Hi ${greet}! ` : '';
  const body =
    `Payment received — ${money} confirmed for your order (${lines}). ` +
    `Your tracking reference is ${input.trackingReference}. ` +
    `We've started processing it now — you'll get an update as it moves to shipped and delivered.`;
  return header + body;
}