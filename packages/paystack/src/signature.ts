import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies a Paystack webhook signature. Paystack signs the RAW request body
 * with HMAC-SHA512 using the secret key and sends it in the
 * `x-paystack-signature` header. We compare against a constant-time digest so
 * timing cannot leak the secret.
 *
 * The caller must pass the exact body bytes that arrived (the body parsed by
 * Express would differ — `rawBody` is enabled on the API bootstrap).
 */
export function verifyPaystackSignature({
  rawBody,
  signature,
  secret,
}: {
  rawBody: string | Buffer;
  signature: string;
  secret: string;
}): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(String(signature), 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}