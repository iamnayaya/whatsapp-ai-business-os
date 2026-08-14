import { describe, expect, it, vi } from 'vitest';
import { WebhookService } from '../src/webhook/webhook.service';
import { loadEnv, QUEUE_NAMES, type AppLogger } from '../../../packages/shared/src';
import { createLogger } from '../../../packages/shared/src/logger';
import type { AuditService } from '../../../packages/audit/src';
import type { IncomingEvent } from '../../../packages/db/src';
import type { InboundMessageJobData } from '../../../packages/queue/src';
import type { Queue } from 'bullmq';

const silentLogger: AppLogger = createLogger('test', { destination: () => undefined });

function p2002(): never {
  throw Object.assign(new Error('unique constraint'), { code: 'P2002' });
}

type Row = Record<string, unknown>;

class FakePrisma {
  events: Row[] = [];
  messages: Row[] = [];
  conversations: Row[] = [];
  customers: Row[] = [];
  businesses: Row[] = [];
  private seq = 0;

  incomingEvent = {
    create: async ({ data }: { data: Row }) => {
      if (this.events.some((e) => e.eventKey === data.eventKey)) p2002();
      const row: Row = { id: `evt-${++this.seq}`, status: 'PENDING', attempts: 0, createdAt: new Date(), ...data };
      this.events.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { eventKey: string } }) =>
      this.events.find((e) => e.eventKey === where.eventKey) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.events.find((e) => e.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    count: async () => this.events.length,
  };

  message = {
    create: async ({ data }: { data: Row }) => {
      if (data.waMessageId && this.messages.some((m) => m.waMessageId === data.waMessageId)) p2002();
      const row: Row = { id: `msg-${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      this.messages.push(row);
      return row;
    },
    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; waMessageId?: string };
      include?: { conversation?: boolean };
    }) => {
      const m = this.messages.find((x) => x.id === where.id || x.waMessageId === where.waMessageId);
      if (!m) return null;
      if (include?.conversation) {
        const conv = this.conversations.find((c) => c.id === m.conversationId);
        return { ...m, conversation: { businessId: conv?.businessId } };
      }
      return m;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.messages.find((m) => m.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
    count: async () => this.messages.length,
  };

  conversation = {
    findFirst: async ({ where }: { where: { businessId: string; customerId: string } }) =>
      this.conversations.find((c) => c.businessId === where.businessId && c.customerId === where.customerId) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `conv-${++this.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
      this.conversations.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      const row = this.conversations.find((c) => c.id === where.id);
      if (!row) throw new Error('not found');
      Object.assign(row, data);
      return row;
    },
  };

  customer = {
    findUnique: async ({ where }: { where: { businessId_waId: { businessId: string; waId: string } } }) =>
      this.customers.find(
        (c) => c.businessId === where.businessId_waId.businessId && c.waId === where.businessId_waId.waId,
      ) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `cust-${++this.seq}`, createdAt: new Date(), ...data };
      this.customers.push(row);
      return row;
    },
  };

  business = {
    findUnique: async ({ where }: { where: { phoneNumber: string } }) =>
      this.businesses.find((b) => b.phoneNumber === where.phoneNumber) ?? null,
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `biz-${++this.seq}`, createdAt: new Date(), ...data };
      this.businesses.push(row);
      return row;
    },
  };
}

function buildService() {
  const prisma = new FakePrisma();
  const queue = { add: vi.fn().mockResolvedValue({}) } as unknown as Queue<InboundMessageJobData>;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const config = loadEnv({
    DATABASE_URL: 'postgresql://x',
    REDIS_URL: 'redis://x',
    WHATSAPP_ACCESS_TOKEN: 't',
    WHATSAPP_PHONE_NUMBER_ID: 'FALLBACK_PNID',
    WHATSAPP_VERIFY_TOKEN: 'v',
    WHATSAPP_APP_SECRET: 's',
    GEMINI_API_KEY: 'gemini-key',
  });
  const service = new WebhookService({
    prisma: prisma as unknown as import('../../../packages/db/src').PrismaClient,
    queue,
    audit,
    logger: silentLogger,
    config,
  });
  return { service, prisma, queue, audit };
}

const TS = String(Math.floor(Date.now() / 1000));

function changePayload(messageOverrides: Record<string, unknown>): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: 'PNID_1' },
              contacts: [{ profile: { name: 'Amina' }, wa_id: '2348012345678' }],
              messages: [messageOverrides],
            },
          },
        ],
      },
    ],
  };
}

function textPayload(): Record<string, unknown> {
  return changePayload({ from: '2348012345678', id: 'wamid.text.1', timestamp: TS, type: 'text', text: { body: 'Price?' } });
}

function interactivePayload(): Record<string, unknown> {
  return changePayload({
    from: '2348012345678',
    id: 'wamid.btn.1',
    timestamp: TS,
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'btn-1', title: 'Yes, order' } },
  });
}

function statusPayload(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [{ id: 'wamid.text.1', status: 'delivered', timestamp: TS, recipient_id: '2348012345678' }],
            },
          },
        ],
      },
    ],
  };
}

describe('WebhookService', () => {
  it('stores the FULL raw event before processing, then ingests the message', async () => {
    const { service, prisma, queue, audit } = buildService();
    await service.handleWebhook(textPayload());

    // Raw event captured first: full change value, keyed by msg:<waId>
    const rawEvent = prisma.events.find((e) => e.eventKey === 'msg:wamid.text.1');
    expect(rawEvent).toBeDefined();
    expect(rawEvent!.status).toBe('PROCESSED');
    expect(rawEvent!.type).toBe('message');
    const payload = rawEvent!.payload as { messages: Array<{ id: string }>; contacts: Array<{ wa_id: string }> };
    expect(payload.messages[0].id).toBe('wamid.text.1');
    expect(payload.contacts[0].wa_id).toBe('2348012345678');

    // Downstream rows
    expect(prisma.businesses).toHaveLength(1);
    expect(prisma.customers).toHaveLength(1);
    expect(prisma.conversations).toHaveLength(1);
    expect(prisma.messages).toHaveLength(1);
    const message = prisma.messages[0];
    expect(message.waMessageId).toBe('wamid.text.1');
    expect(message.text).toBe('Price?');
    expect(message.status).toBe('RECEIVED');

    expect(queue.add).toHaveBeenCalledWith(
      QUEUE_NAMES.WHATSAPP_MESSAGES,
      expect.objectContaining({ messageId: message.id, customerWaId: '2348012345678' }),
      { jobId: 'wamid.text.1' },
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'MESSAGE_INGESTED' }));
  });

  it('is idempotent: re-delivering the same webhook stores one event and one message', async () => {
    const { service, prisma, queue } = buildService();
    await service.handleWebhook(textPayload());
    await service.handleWebhook(textPayload());

    expect(prisma.events).toHaveLength(1);
    expect(prisma.messages).toHaveLength(1);
    expect(prisma.events[0].status).toBe('PROCESSED');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('resumes an in-flight duplicate (event PENDING) without double rows', async () => {
    const { service, prisma, queue } = buildService();
    await service.handleWebhook(textPayload());
    const event = prisma.events[0];
    event.status = 'PENDING';
    event.processedAt = null;
    await service.handleWebhook(textPayload());

    expect(prisma.events).toHaveLength(1);
    expect(prisma.messages).toHaveLength(1);
    expect(prisma.events[0].status).toBe('PROCESSED');
    expect(queue.add).toHaveBeenCalledTimes(2); // re-enqueued, jobId dedupes in BullMQ
  });

  it('extracts the reply text from interactive button replies', async () => {
    const { service, prisma } = buildService();
    await service.handleWebhook(interactivePayload());
    expect(prisma.messages).toHaveLength(1);
    expect(prisma.messages[0].type).toBe('interactive');
    expect(prisma.messages[0].text).toBe('Yes, order');
  });

  it('captures status events separately and applies delivery status', async () => {
    const { service, prisma, audit } = buildService();
    await service.handleWebhook(textPayload());
    await service.handleWebhook(statusPayload());

    // Status change = its own raw event, distinct key from the message event
    expect(prisma.events).toHaveLength(2);
    const statusEvent = prisma.events.find((e) => e.eventKey === 'status:wamid.text.1');
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.status).toBe('PROCESSED');

    expect(prisma.messages[0].status).toBe('DELIVERED');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'MESSAGE_STATUS_UPDATED' }));
  });

  it('leaves a status event PENDING when the message has not arrived yet, then heals on re-delivery', async () => {
    const { service, prisma } = buildService();
    // Delivery receipt races ahead of the message
    await service.handleWebhook(statusPayload());
    expect(prisma.messages).toHaveLength(0);
    const pending = prisma.events.find((e) => e.eventKey === 'status:wamid.text.1');
    expect(pending!.status).toBe('PENDING');

    await service.handleWebhook(textPayload());
    // Same status re-delivered -> event exists PENDING -> resume -> applied
    await service.handleWebhook(statusPayload());
    expect(prisma.messages[0].status).toBe('DELIVERED');
    const healed = prisma.events.find((e) => e.eventKey === 'status:wamid.text.1');
    expect(healed!.status).toBe('PROCESSED');
  });

  it('stores raw events for non-message fields without creating rows', async () => {
    const { service, prisma, queue } = buildService();
    await service.handleWebhook({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA_ID', changes: [{ field: 'account_update', value: { something: 1 } }] }],
    });
    expect(prisma.events).toHaveLength(1);
    expect(prisma.events[0].type).toBe('change:account_update');
    expect(prisma.events[0].status).toBe('PROCESSED');
    expect(prisma.messages).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('can read a stored event back by key (insert/read events table)', async () => {
    const { service, prisma } = buildService();
    await service.handleWebhook(textPayload());
    const found = await prisma.incomingEvent.findUnique({ where: { eventKey: 'msg:wamid.text.1' } });
    expect(found).not.toBeNull();
    expect((found as unknown as IncomingEvent).payload).toBeDefined();
  });
});