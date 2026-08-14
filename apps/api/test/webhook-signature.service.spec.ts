import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { WebhookSignatureService } from '../src/webhook/webhook-signature.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';
const service = new WebhookSignatureService({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN });

function sign(body: Buffer, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('WebhookSignatureService', () => {
  it('verifies a correctly signed body', () => {
    const body = Buffer.from('{"entry":[]}');
    expect(service.verify(body, sign(body))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('{"entry":[]}');
    expect(service.verify(Buffer.from('{"entry":[1]}'), sign(body))).toBe(false);
  });

  it('rejects a signature produced with the wrong secret', () => {
    const body = Buffer.from('{"entry":[]}');
    expect(service.verify(body, sign(body, 'wrong-secret'))).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    const body = Buffer.from('{"entry":[]}');
    expect(service.verify(body, undefined)).toBe(false);
    expect(service.verify(body, '')).toBe(false);
    expect(service.verify(body, 'not-a-signature')).toBe(false);
    expect(service.verify(body, `sha256=zzz`)).toBe(false);
  });

  it('exposes the configured verify token for the GET handshake', () => {
    expect(service.verifyToken).toBe(VERIFY_TOKEN);
  });
});