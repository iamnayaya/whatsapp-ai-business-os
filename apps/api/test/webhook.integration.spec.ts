import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../../packages/db/src';
import { createLogger, loadEnv, EVENT_STATUS, MESSAGE_STATUS } from '../../../packages/shared/src';
import { createAuditService, type AuditService } from '../../../packages/audit/src';
import {
  createWhatsappMessageQueue,
  createWhatsappMessageWorker,
  type Queue,
  type Worker,
} from '../../../packages/queue/src';
import { WebhookService } from '../src/webhook/webhook.service';
import { handleInboundMessage } from '../../../apps/worker/src/handler';
import { createWhatsAppClient } from '../../../packages/whatsapp/src';

let prisma: PrismaClient;
let queue: Queue;
let worker: Worker;
let service: WebhookService;
let audit: AuditService;

const logger = createLogger('integration');

const TS = String(Math.floor(Date.now() / 1000));

function textPayload(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_INTEGRATION',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15551234567', phone_number_id: 'INTEGRATION_PNID' },
              contacts: [{ profile: { name: 'Integration Tester' }, wa_id: '2348099999999' }],
              messages: [
                { from: '2348099999999', id: 'wamid.integration.1', timestamp: TS, type: 'text', text: { body: 'How much?' } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(): Record<string, unknown> {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_INTEGRATION',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              statuses: [{ id: 'wamid.integration.1', status: 'read', timestamp: TS, recipient_id: '2348099999999' }],
            },
          },
        ],
      },
    ],
  };
}

async function waitForMessageStatus(waMessageId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const msg = await prisma.message.findUnique({ where: { waMessageId } });
    if (msg?.status === status) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${waMessageId} to reach ${status} (got ${msg?.status})`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

beforeAll(async () => {
  const env = loadEnv();
  prisma = createPrismaClient();
  audit = createAuditService({ prisma, logger });
  queue = createWhatsappMessageQueue({ url: env.REDIS_URL });
  const whatsapp = createWhatsAppClient({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
    logger,
  });
  worker = createWhatsappMessageWorker({
    url: env.REDIS_URL,
    processor: (job) =>
      handleInboundMessage(job, {
        prisma,
        audit,
        logger,
        whatsapp,
        // Phase 2 agent is exercised by its own unit tests; the integration
        // spec proves the Foundation pipeline (ingest -> queue -> process).
        agent: {
          run: async () => ({ text: 'No reply', escalated: false, toolCalls: [] }),
        } as never,
        transcriber: { transcribe: async () => ({ text: '', language: 'unknown', confidence: 0, clear: false }) },
        killSwitch: { isActive: async () => false },
      }),
  });
  service = new WebhookService({ prisma, queue, audit, logger, config: env });
});

afterAll(async () => {
  await worker?.close();
  await queue?.close();
  await prisma?.$disconnect();
});

describe('WhatsApp webhook ingestion (real Postgres + Redis + BullMQ)', () => {
  it('ingests a message exactly once across duplicate deliveries and processes it', async () => {
    const payload = textPayload();

    await service.handleWebhook(payload);
    await service.handleWebhook(payload); // duplicate delivery

    expect(await prisma.message.count()).toBe(1);
    expect(await prisma.incomingEvent.count()).toBe(1);
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.business.count()).toBe(1);

    const event = await prisma.incomingEvent.findUnique({ where: { eventKey: 'msg:wamid.integration.1' } });
    expect(event?.status).toBe(EVENT_STATUS.PROCESSED);
    const rawPayload = event?.payload as { messages: Array<{ id: string; text: { body: string } }> };
    expect(rawPayload.messages[0].id).toBe('wamid.integration.1');
    expect(rawPayload.messages[0].text.body).toBe('How much?');

    await waitForMessageStatus('wamid.integration.1', MESSAGE_STATUS.PROCESSED);

    const message = await prisma.message.findUnique({ where: { waMessageId: 'wamid.integration.1' } });
    expect(message?.text).toBe('How much?');
    expect(message?.status).toBe(MESSAGE_STATUS.PROCESSED);

    const auditCount = await prisma.agentAction.count({
      where: { action: 'MESSAGE_INGESTED' },
    });
    expect(auditCount).toBeGreaterThanOrEqual(1);
  });

  it('applies a delivery status to a known message', async () => {
    await service.handleWebhook(statusPayload());
    await waitForMessageStatus('wamid.integration.1', MESSAGE_STATUS.READ);
    const message = await prisma.message.findUnique({ where: { waMessageId: 'wamid.integration.1' } });
    expect(message?.status).toBe(MESSAGE_STATUS.READ);
  });
});