import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { verifyPaystackSignature } from '../src/signature';

const SECRET = 'sk_test_super_secret';
const BODY = JSON.stringify({ event: 'charge.success', data: { reference: 'PAY-ref-1', amount: 17000000 } });

function sign(raw: string | Buffer, secret: string): string {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

describe('verifyPaystackSignature', () => {
  it('accepts a valid HMAC-SHA512 signature of the raw body', () => {
    expect(verifyPaystackSignature({ rawBody: BODY, signature: sign(BODY, SECRET), secret: SECRET })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const forged = BODY.replace('17000000', '1000000');
    expect(verifyPaystackSignature({ rawBody: forged, signature: sign(BODY, SECRET), secret: SECRET })).toBe(false);
  });

  it('rejects a signature from the wrong secret', () => {
    expect(verifyPaystackSignature({ rawBody: BODY, signature: sign(BODY, 'attacker-secret'), secret: SECRET })).toBe(false);
  });

  it('rejects missing signature or secret', () => {
    expect(verifyPaystackSignature({ rawBody: BODY, signature: '', secret: SECRET })).toBe(false);
    expect(verifyPaystackSignature({ rawBody: BODY, signature: sign(BODY, SECRET), secret: '' })).toBe(false);
  });

  it('verifies a Buffer raw body identically to a string', () => {
    const buf = Buffer.from(BODY, 'utf8');
    expect(verifyPaystackSignature({ rawBody: buf, signature: sign(buf, SECRET), secret: SECRET })).toBe(true);
  });
});