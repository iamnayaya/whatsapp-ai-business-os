import { describe, expect, it, vi } from 'vitest';
import { FollowUpService, type FollowUpServiceDeps } from '../src/engine';
import { FOLLOWUP_DEFAULT_CONFIG, type FollowUpConfig } from '../src/timing';
import type { AuditService } from '../../audit/src';
import type { WhatsAppClient } from '../../whatsapp/src';
import { createLogger, AUDIT_ACTIONS, FOLLOWUP_STATUS, MESSAGE_DIRECTION, MESSAGE_STATUS } from '../../shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

const RICE = { productId: 'p1', productName: 'Rice 50kg', quantity: 2, unitPrice: 85000 };

function conv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-1',
    businessId: 'biz-1',
    customerId: 'cust-1',
    status: 'OPEN',
    lastMessageAt: new Date('2026-08-13T10:00:00.000Z'),
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    metadata: { cart: { items: [RICE] } },
    business: { name: 'Ahmad Nayaya', timezone: 'Africa/Lagos', currency: 'NGN' },
    customer: { name: 'Amina', profileName: null, waId: '2348012345678' },
    ...overrides,
  };
}

interface PrismaFake {
  conversation: {
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  message: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  followUp: {
    groupBy: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  _followUps: Array<Record<string, unknown>>;
}

/** In-memory Prisma fake: follow-up rows persist across scans so the 2-attempt cap is testable. */
function makePrisma(opts: { conversations?: unknown[]; paymentConversations?: unknown[]; lastInbound?: Record<string, Date> } = {}): PrismaFake {
  const followUps: Array<Record<string, unknown>> = [];
  const lastInbound = opts.lastInbound ?? {};
  return {
    conversation: {
      findMany: vi.fn(async ({ where }: { where?: { customer?: { orders?: { some?: unknown } } } } = {}) => {
        if (where?.customer?.orders?.some) return opts.paymentConversations ?? [];
        return opts.conversations ?? [conv()];
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where?: { conversationId?: { in?: string[] }; direction?: string } } = {}) => {
        const ids = where?.conversationId?.in ?? [];
        return ids.filter((id) => lastInbound[id]).map((id) => ({ conversationId: id, sentAt: lastInbound[id] }));
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `msg-${followUps.length + 1}`, ...data })),
    },
    followUp: {
      groupBy: vi.fn(async ({ where }: { where: { conversationId?: { in?: string[] }; type?: string } }) => {
        const ids = where?.conversationId?.in ?? [];
        const type = where?.type;
        return ids
          .map((id) => ({ conversationId: id, _count: { _all: followUps.filter((f) => f.conversationId === id && f.type === type).length } }))
          .filter((g) => g._count._all > 0);
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const dup = followUps.find(
          (f) => f.conversationId === data.conversationId && f.type === data.type && f.attempt === data.attempt,
        );
        if (dup) {
          const err = new Error('Unique constraint failed on the fields: (`conversationId`,`type`,`attempt`)');
          (err as { code?: string }).code = 'P2002';
          throw err;
        }
        const row = { id: `fu-${followUps.length + 1}`, ...data, createdAt: new Date() };
        followUps.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = followUps.find((f) => f.id === where.id);
        if (!row) throw new Error('FollowUp not found');
        Object.assign(row, data);
        return row;
      }),
    },
    _followUps: followUps,
  };
}

function makeDeps(prisma: PrismaFake, overrides: Partial<FollowUpServiceDeps> = {}) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const whatsapp = { sendText: vi.fn(async () => ({ waMessageId: 'wamid.fu.1' })) } as unknown as WhatsAppClient;
  const deps: FollowUpServiceDeps = {
    prisma: prisma as never,
    whatsapp,
    audit,
    logger: silentLogger,
    config: { ...FOLLOWUP_DEFAULT_CONFIG, firstDelayMs: 2 * 60 * 60 * 1000, secondDelayMs: 24 * 60 * 60 * 1000, quietStartHour: 0, quietEndHour: 0 },
    ...overrides,
  };
  return { deps, audit: audit as unknown as { record: ReturnType<typeof vi.fn> }, whatsapp: whatsapp as unknown as { sendText: ReturnType<typeof vi.fn> } };
}

const TWO_HOURS = 2 * 60 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

describe('FollowUpService.runScan', () => {
  it('sends a follow-up naming the cart items, records it, and audits', async () => {
    const prisma = makePrisma();
    const { deps, audit, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);
    const now = new Date('2026-08-13T12:00:00.000Z'); // 2h after last message

    const summary = await service.runScan({ now });

    expect(summary).toEqual({
      scanned: 1,
      sent: 1,
      skippedNoCart: 0,
      skippedNotDue: 0,
      skippedCapped: 0,
      skippedQuietHours: 0,
      scannedPayments: 0,
      sentPayments: 0,
      skippedPaymentNotDue: 0,
      skippedPaymentCapped: 0,
      skippedPaymentQuietHours: 0,
    });
    expect(whatsapp.sendText).toHaveBeenCalledWith('2348012345678', expect.stringContaining('Rice 50kg'));
    expect(prisma._followUps).toHaveLength(1);
    expect(prisma._followUps[0]).toMatchObject({ conversationId: 'conv-1', attempt: 1, status: FOLLOWUP_STATUS.SENT, waMessageId: 'wamid.fu.1' });
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: 'conv-1',
          direction: MESSAGE_DIRECTION.OUTBOUND,
          type: 'text',
          text: expect.stringContaining('Rice 50kg'),
          status: MESSAGE_STATUS.SENT,
        }),
      }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv-1' }, data: expect.objectContaining({ lastMessageAt: now }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.FOLLOW_UP_SENT, entityType: 'FOLLOW_UP' }));
  });

  it('claims the attempt (SENDING) before sending — records failure and rethrows on send error', async () => {
    const prisma = makePrisma();
    const { deps, whatsapp } = makeDeps(prisma);
    whatsapp.sendText.mockRejectedValueOnce(new Error('whatsapp down'));
    const service = new FollowUpService(deps);
    const now = new Date('2026-08-13T12:00:00.000Z');

    await expect(service.runScan({ now })).rejects.toThrow('whatsapp down');

    expect(prisma._followUps[0]).toMatchObject({ attempt: 1, status: FOLLOWUP_STATUS.FAILED });
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('caps at 2 attempts across repeated scans and never sends a third', async () => {
    const prisma = makePrisma();
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    // Scan 1 — 2h quiet -> attempt 1.
    await service.runScan({ now: new Date('2026-08-13T12:00:00.000Z') });
    expect(prisma._followUps).toHaveLength(1);

    // Scan 2 — still only 2h later: attempt 2 is not due (needs 24h) -> no double send.
    const scan2 = await service.runScan({ now: new Date('2026-08-13T12:01:00.000Z') });
    expect(scan2.sent).toBe(0);
    expect(scan2.skippedNotDue).toBe(1);
    expect(prisma._followUps).toHaveLength(1);

    // Scan 3 — 24h+ later -> attempt 2.
    const scan3 = await service.runScan({ now: new Date('2026-08-14T12:00:00.000Z') });
    expect(scan3.sent).toBe(1);
    expect(prisma._followUps).toHaveLength(2);

    // Scan 4 — long after -> capped, nothing sent.
    const scan4 = await service.runScan({ now: new Date('2026-08-20T12:00:00.000Z') });
    expect(scan4.sent).toBe(0);
    expect(scan4.skippedCapped).toBe(1);
    expect(prisma._followUps).toHaveLength(2);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(2);
  });

  it('does not send before the delay elapses', async () => {
    const prisma = makePrisma();
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-13T11:00:00.000Z') }); // 1h quiet

    expect(summary.skippedNotDue).toBe(1);
    expect(summary.sent).toBe(0);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('skips carts during quiet hours in the business timezone', async () => {
    const prisma = makePrisma();
    const { deps, whatsapp } = makeDeps(prisma, {
      config: { ...FOLLOWUP_DEFAULT_CONFIG, firstDelayMs: TWO_HOURS, secondDelayMs: ONE_DAY, quietStartHour: 21, quietEndHour: 9 },
    });
    const service = new FollowUpService(deps);

    // Last message 2 days ago; now = 23:00 Lagos (22:00 UTC) -> quiet.
    const summary = await service.runScan({ now: new Date('2026-08-15T22:00:00.000Z') });

    expect(summary.skippedQuietHours).toBe(1);
    expect(summary.sent).toBe(0);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma._followUps).toHaveLength(0);
  });

  it('skips conversations with no cart and never queries follow-ups for them', async () => {
    const noCart = conv({ metadata: {} });
    const emptyCart = conv({ id: 'conv-2', metadata: { cart: { items: [] } } });
    const prisma = makePrisma({ conversations: [noCart, emptyCart] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-13T12:00:00.000Z') });

    expect(summary.scanned).toBe(0);
    expect(summary.sent).toBe(0);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
    expect(prisma.followUp.groupBy).not.toHaveBeenCalled();
  });

  it('uses the last INBOUND message as the quiet clock when present', async () => {
    const prisma = makePrisma({
      conversations: [conv()],
      lastInbound: { 'conv-1': new Date('2026-08-13T11:30:00.000Z') }, // only 30 min ago
    });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-13T12:00:00.000Z') });

    expect(summary.skippedNotDue).toBe(1);
    expect(summary.sent).toBe(0);
    expect(whatsapp.sendText).not.toHaveBeenCalled();
  });

  it('is idempotent against a racing duplicate attempt (P2002)', async () => {
    const prisma = makePrisma();
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);
    const now = new Date('2026-08-13T12:00:00.000Z');

    const first = await service.runScan({ now });
    expect(first.sent).toBe(1);

    // Simulate a second scan instance that somehow recomputed the same attempt
    // (groupBy reports 0), so the unique [conversationId, attempt] claim fails
    // and the second send is silently skipped.
    prisma.followUp.groupBy.mockResolvedValueOnce([]);
    const second = await service.runScan({ now });

    expect(second.sent).toBe(0);
    expect(prisma._followUps).toHaveLength(1);
    expect(whatsapp.sendText).toHaveBeenCalledTimes(1);
  });
});

/** A conversation whose customer has an order stuck on PAYMENT_PENDING. */
function payConv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'conv-pay-1',
    businessId: 'biz-1',
    customerId: 'cust-1',
    status: 'OPEN',
    lastMessageAt: new Date('2026-08-13T10:00:00.000Z'),
    createdAt: new Date('2026-08-13T09:00:00.000Z'),
    business: { name: 'Ahmad Nayaya', timezone: 'Africa/Lagos', currency: 'NGN' },
    customer: {
      name: 'Amina',
      profileName: null,
      waId: '2348012345678',
      orders: [
        {
          id: 'order-pay-1',
          total: 170000,
          currency: 'NGN',
          status: 'PAYMENT_PENDING',
          payments: [
            {
              reference: 'PAY-ref-1',
              status: 'PENDING',
              providerPayload: { authorizationUrl: 'https://paystack.com/pay/abc123' },
            },
          ],
          items: [{ productId: 'p1', product: { name: 'Rice 50kg' }, quantity: 2, unitPrice: 85000 }],
        },
      ],
    },
    ...overrides,
  };
}

describe('FollowUpService payment pass (Phase 7)', () => {
  it('nudges an order stuck on payment, re-sharing the payment link', async () => {
    const prisma = makePrisma({ paymentConversations: [payConv()] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);
    const now = new Date('2026-08-13T12:00:00.000Z'); // 2h quiet

    const summary = await service.runScan({ now });

    expect(summary.scannedPayments).toBe(1);
    expect(summary.sentPayments).toBe(1);
    expect(summary.scanned).toBe(1); // cart pass still sees the default cart conv
    expect(whatsapp.sendText).toHaveBeenCalledWith(
      '2348012345678',
      expect.stringContaining('https://paystack.com/pay/abc123'),
    );
    expect(whatsapp.sendText).toHaveBeenCalledWith('2348012345678', expect.stringContaining('₦170,000'));
    const paymentFollowUp = prisma._followUps.find((f) => f.type === 'PAYMENT');
    expect(paymentFollowUp).toMatchObject({ conversationId: 'conv-pay-1', attempt: 1, status: 'SENT' });
  });

  it('does not nudge a payment that has not gone quiet', async () => {
    const prisma = makePrisma({ paymentConversations: [payConv()] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-13T11:00:00.000Z') }); // 1h quiet

    expect(summary.sentPayments).toBe(0);
    expect(summary.skippedPaymentNotDue).toBe(1);
    expect(whatsapp.sendText).not.toHaveBeenCalledWith('2348012345678', expect.stringContaining('paystack.com/pay'));
  });

  it('caps payment nudges independently from cart nudges at 2 attempts', async () => {
    const prisma = makePrisma({ paymentConversations: [payConv()] });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    await service.runScan({ now: new Date('2026-08-13T12:00:00.000Z') }); // attempt 1
    await service.runScan({ now: new Date('2026-08-14T12:00:00.000Z') }); // attempt 2 (24h+)
    const third = await service.runScan({ now: new Date('2026-08-20T12:00:00.000Z') }); // capped

    expect(third.sentPayments).toBe(0);
    expect(third.skippedPaymentCapped).toBe(1);
    const paymentFollowUps = prisma._followUps.filter((f) => f.type === 'PAYMENT');
    expect(paymentFollowUps).toHaveLength(2);
    expect(paymentFollowUps.map((f) => f.attempt).sort()).toEqual([1, 2]);
  });

  it('skips payment nudges during quiet hours', async () => {
    const prisma = makePrisma({ paymentConversations: [payConv()] });
    const { deps, whatsapp } = makeDeps(prisma, {
      config: { ...FOLLOWUP_DEFAULT_CONFIG, firstDelayMs: TWO_HOURS, secondDelayMs: ONE_DAY, quietStartHour: 21, quietEndHour: 9 },
    });
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-15T22:00:00.000Z') }); // 23:00 Lagos

    expect(summary.skippedPaymentQuietHours).toBe(1);
    expect(summary.sentPayments).toBe(0);
    expect(prisma._followUps).toHaveLength(0);
  });

  it('never sends a payment nudge when the payment link is missing', async () => {
    const prisma = makePrisma({
      paymentConversations: [
        payConv({
          customer: {
            ...payConv().customer,
            orders: [
              {
                id: 'order-pay-2',
                total: 170000,
                currency: 'NGN',
                status: 'PAYMENT_PENDING',
                payments: [{ reference: 'PAY-ref-2', status: 'PENDING', providerPayload: {} }],
                items: [{ productId: 'p1', product: { name: 'Rice 50kg' }, quantity: 2, unitPrice: 85000 }],
              },
            ],
          },
        }),
      ],
    });
    const { deps, whatsapp } = makeDeps(prisma);
    const service = new FollowUpService(deps);

    const summary = await service.runScan({ now: new Date('2026-08-13T12:00:00.000Z') }); // 2h quiet, due

    expect(summary.sentPayments).toBe(0);
    expect(prisma._followUps.filter((f) => f.type === 'PAYMENT')).toHaveLength(0);
    expect(whatsapp.sendText).not.toHaveBeenCalledWith('2348012345678', expect.stringContaining('paystack.com'));
  });
});