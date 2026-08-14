import { createHmac } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { PaystackWebhookService } from '../src/payments/paystack-webhook.service';
import type { Env } from '../../../packages/shared/src';
import { EVENT_STATUS } from '../../../packages/shared/src';
import type { Queue } from 'bullmq';
import type { PaymentEventJobData } from '../../../packages/queue/src';

function makeConfig(overrides: Partial<Env> = {}): Env {
  return { PAYSTACK_SECRET_KEY: 'sk_test_abc', ...overrides } as unknown as Env;
}

function sign(raw: string | Buffer, secret: string): string {
  return createHmac('sha512', secret).update(raw).digest('hex');
}

function makeDeps(config: Env = makeConfig()) {
  const events: Array<Record<string, unknown>> = [];
  const prisma = {
    incomingEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (events.some((e) => e.eventKey === data.eventKey)) {
          const err = new Error('Unique constraint failed on the fields: (`eventKey`)');
          (err as { code?: string }).code = 'P2002';
          throw err;
        }
        const row = { id: `evt-${events.length + 1}`, ...data, status: EVENT_STATUS.PENDING };
        events.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { eventKey: string } }) => events.find((e) => e.eventKey === where.eventKey) ?? null),
    },
    _events: events,
  };
  const queue = {
    add: vi.fn(async (_name: string, _data: unknown, opts?: { jobId?: string }) => ({ id: opts?.jobId ?? 'job-1' })),
  } as unknown as Queue<PaymentEventJobData>;
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    prisma: prisma as never,
    queue,
    audit: audit as never,
    logger: logger as never,
    config,
  };
  return {
    service: new PaystackWebhookService(deps as never),
    prisma,
    queue,
    audit: audit as { record: ReturnType<typeof vi.fn> },
  };
}

const BODY = JSON.stringify({ event: 'charge.success', data: { id: 123456, reference: 'PAY-ref-1', amount: 16950000 } });

describe('PaystackWebhookService', () => {
  it('verifies a valid HMAC-SHA512 signature', () => {
    const { service } = makeDeps();
    expect(service.verifySignature(BODY, sign(BODY, 'sk_test_abc'))).toBe(true);
  });

  it('rejects a forged signature', () => {
    const { service } = makeDeps();
    expect(service.verifySignature(BODY, sign(BODY, 'attacker-secret'))).toBe(false);
    expect(service.verifySignature(BODY, undefined)).toBe(false);
  });

  it('fails closed when the secret is not configured', () => {
    const { service } = makeDeps(makeConfig({ PAYSTACK_SECRET_KEY: undefined }));
    expect(service.verifySignature(BODY, sign(BODY, 'sk_test_abc'))).toBe(false);
  });

  it('captures the raw event, enqueues a deduped job, and audits', async () => {
    const { service, prisma, queue, audit } = makeDeps();

    await service.handleWebhook(JSON.parse(BODY) as Parameters<PaystackWebhookService['handleWebhook']>[0]);

    expect(prisma._events).toHaveLength(1);
    expect(prisma._events[0]).toMatchObject({ eventKey: 'paystack:charge.success:123456', status: EVENT_STATUS.PENDING });
    expect(queue.add).toHaveBeenCalledWith('payment-events', expect.objectContaining({ eventKey: 'paystack:charge.success:123456' }), {
      jobId: 'paystack:charge.success:123456',
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYMENT_WEBHOOK_RECEIVED' }));
  });

  it('skips a duplicate delivery that was already processed', async () => {
    const { service, prisma, queue } = makeDeps();
    const payload = JSON.parse(BODY) as Parameters<PaystackWebhookService['handleWebhook']>[0];

    await service.handleWebhook(payload);
    // Simulate the worker having processed it.
    prisma._events[0].status = EVENT_STATUS.PROCESSED;

    await service.handleWebhook(payload);

    expect(prisma._events).toHaveLength(1);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('still captures + enqueues a duplicate delivery whose event is still PENDING (worker dedupes via jobId)', async () => {
    const { service, prisma, queue } = makeDeps();
    const payload = JSON.parse(BODY) as Parameters<PaystackWebhookService['handleWebhook']>[0];

    await service.handleWebhook(payload);
    await service.handleWebhook(payload);

    expect(prisma._events).toHaveLength(1); // one raw row
    expect(queue.add).toHaveBeenCalledTimes(2); // BullMQ jobId dedupes the second add
    expect(queue.add).toHaveBeenLastCalledWith('payment-events', expect.anything(), { jobId: 'paystack:charge.success:123456' });
  });
});