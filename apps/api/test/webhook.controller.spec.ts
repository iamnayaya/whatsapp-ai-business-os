import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { WebhookController } from '../src/webhook/webhook.controller';
import { WebhookSignatureService } from '../src/webhook/webhook-signature.service';
import type { WebhookService } from '../src/webhook/webhook.service';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function makeController(serviceOverrides: Partial<WebhookService> = {}) {
  const service = { handleWebhook: vi.fn().mockResolvedValue(undefined), ...serviceOverrides } as unknown as WebhookService;
  const controller = new WebhookController(
    new WebhookSignatureService({ appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN }),
    service,
  );
  return { controller, service };
}

function makeReq(payload: unknown, signature?: string): Request {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return {
    rawBody,
    headers: signature ? { 'x-hub-signature-256': signature } : {},
  } as unknown as Request;
}

function sign(payload: unknown): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(JSON.stringify(payload)).digest('hex')}`;
}

describe('WebhookController', () => {
  it('GET verify echoes the challenge for a valid verification request', () => {
    const { controller } = makeController();
    const challenge = controller.verify('subscribe', VERIFY_TOKEN, 'my-challenge-123');
    expect(challenge).toBe('my-challenge-123');
  });

  it('GET verify rejects a wrong verify token', () => {
    const { controller } = makeController();
    expect(() => controller.verify('subscribe', 'wrong', 'challenge')).toThrow(UnauthorizedException);
  });

  it('GET verify rejects a wrong mode', () => {
    const { controller } = makeController();
    expect(() => controller.verify('unsubscribe', VERIFY_TOKEN, 'challenge')).toThrow(UnauthorizedException);
  });

  it('POST forwards a correctly signed payload and acknowledges', async () => {
    const { controller, service } = makeController();
    const payload = { entry: [] };
    const result = await controller.receive(makeReq(payload, sign(payload)), payload);
    expect(result).toEqual({ received: true });
    expect(service.handleWebhook).toHaveBeenCalledWith(payload);
  });

  it('POST rejects an invalid signature and never calls the service', async () => {
    const { controller, service } = makeController();
    const payload = { entry: [] };
    await expect(controller.receive(makeReq(payload, 'sha256=deadbeef'), payload)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.handleWebhook).not.toHaveBeenCalled();
  });

  it('POST rejects a missing signature header', async () => {
    const { controller } = makeController();
    const payload = { entry: [] };
    await expect(controller.receive(makeReq(payload, undefined), payload)).rejects.toThrow(UnauthorizedException);
  });

  it('POST rejects a body that was modified after signing', async () => {
    const { controller, service } = makeController();
    const signed = { entry: [] };
    const tampered = { entry: [{ id: 'x' }] };
    await expect(controller.receive(makeReq(tampered, sign(signed)), tampered)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(service.handleWebhook).not.toHaveBeenCalled();
  });
});