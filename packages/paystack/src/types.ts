/**
 * Types shared by the Paystack client (initialize) and the webhook receiver.
 * Only the fields we actually consume are modelled; everything else rides
 * through as opaque JSON on the Payment.providerPayload.
 */

export interface InitializeTransactionInput {
  /** Amount in the smallest currency unit (kobo for NGN). Integer. */
  amountKobo: number;
  email: string;
  /** Must be unique per transaction — Paystack rejects duplicates. */
  reference: string;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface InitializeTransactionResult {
  reference: string;
  accessCode: string;
  authorizationUrl: string;
}

/** A `charge.success` / `charge.failed` event as Paystack delivers it. */
export interface PaystackChargeData {
  id?: string | number;
  reference: string;
  /** Amount in kobo. */
  amount?: number;
  status?: string;
  currency?: string;
  metadata?: Record<string, unknown> | null;
  paid_at?: string | null;
  gateway_response?: string;
  channel?: string;
  [key: string]: unknown;
}

export interface PaystackWebhookPayload {
  event: string;
  data: PaystackChargeData;
}