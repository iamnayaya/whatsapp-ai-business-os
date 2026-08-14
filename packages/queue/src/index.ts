import { Queue, Worker, type Job, type Processor } from 'bullmq';
import { QUEUE_NAMES } from '../../shared/src/constants';

export interface InboundMessageJobData {
  messageId: string;
  conversationId: string;
  customerId: string;
  customerWaId: string;
  businessId: string;
}

export interface QueueConnectionConfig {
  url: string;
}

/**
 * Default retry policy for ALL jobs: 5 attempts, exponential backoff starting
 * at 5s. Failed jobs are retried before being moved to 'failed'.
 */
export const QUEUE_DEFAULTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

export function createWhatsappMessageQueue({ url }: QueueConnectionConfig): Queue<InboundMessageJobData> {
  return new Queue<InboundMessageJobData>(QUEUE_NAMES.WHATSAPP_MESSAGES, {
    connection: { url },
    defaultJobOptions: QUEUE_DEFAULTS,
  });
}

export interface EnqueueInboundMessageInput {
  queue: Queue<InboundMessageJobData>;
  waMessageId: string;
  data: InboundMessageJobData;
}

/**
 * Idempotent enqueue: BullMQ ignores a job whose `jobId` already exists.
 * Combined with the UNIQUE waMessageId in Postgres this guarantees a
 * webhook delivered twice never creates two work items.
 */
export async function enqueueInboundMessage({ queue, waMessageId, data }: EnqueueInboundMessageInput): Promise<void> {
  await queue.add(QUEUE_NAMES.WHATSAPP_MESSAGES, data, { jobId: waMessageId });
}

export interface CreateWorkerInput {
  url: string;
  processor: Processor<InboundMessageJobData>;
  concurrency?: number;
}

export function createWhatsappMessageWorker({ url, processor, concurrency = 5 }: CreateWorkerInput): Worker<InboundMessageJobData> {
  return new Worker<InboundMessageJobData>(QUEUE_NAMES.WHATSAPP_MESSAGES, processor, {
    connection: { url },
    concurrency,
  });
}

export type InboundMessageJob = Job<InboundMessageJobData, void, string>;

// ---------------------------------------------------------------------------
// Follow-up scan (Phase 5): a BullMQ repeatable (cron) job that runs the
// abandoned-cart engine off the webhook path. Concurrency 1 keeps scans
// serialized so the per-conversation attempt claim is the only guard needed.
// ---------------------------------------------------------------------------

export interface FollowUpScanJobData {
  scanId?: string;
}

export function createFollowUpScanQueue({ url }: QueueConnectionConfig): Queue<FollowUpScanJobData> {
  return new Queue<FollowUpScanJobData>(QUEUE_NAMES.FOLLOW_UP_SCAN, {
    connection: { url },
    defaultJobOptions: QUEUE_DEFAULTS,
  });
}

export interface ScheduleFollowUpScanInput {
  queue: Queue<FollowUpScanJobData>;
  /** Cron pattern (6 fields, seconds first). Default: every 15 minutes. */
  cron: string;
}

/**
 * Registers the recurring scan. BullMQ dedupes repeatable jobs by name +
 * pattern, so calling this on every worker boot is safe.
 */
export async function scheduleFollowUpScan({ queue, cron }: ScheduleFollowUpScanInput): Promise<void> {
  await queue.add(QUEUE_NAMES.FOLLOW_UP_SCAN, {}, { jobId: `repeat:${QUEUE_NAMES.FOLLOW_UP_SCAN}`, repeat: { pattern: cron } });
}

export interface CreateFollowUpScanWorkerInput {
  url: string;
  processor: Processor<FollowUpScanJobData>;
}

export function createFollowUpScanWorker({ url, processor }: CreateFollowUpScanWorkerInput): Worker<FollowUpScanJobData> {
  return new Worker<FollowUpScanJobData>(QUEUE_NAMES.FOLLOW_UP_SCAN, processor, {
    connection: { url },
    concurrency: 1,
  });
}

export type FollowUpScanJob = Job<FollowUpScanJobData, void, string>;

// ---------------------------------------------------------------------------
// Payment events (Phase 7): Paystack charge.success / charge.failed delivered
// by the API webhook are enqueued here and processed by the worker. Concurrency
// 1 keeps stock-deduction claims serialized per order; cross-order races are
// handled by the atomic conditional stock update in the payment service.
// ---------------------------------------------------------------------------

import type { PaystackChargeData } from '../../paystack/src';

export interface PaymentEventJobData {
  eventKey: string;
  event: string;
  data: PaystackChargeData;
}

export function createPaymentEventQueue({ url }: QueueConnectionConfig): Queue<PaymentEventJobData> {
  return new Queue<PaymentEventJobData>(QUEUE_NAMES.PAYMENT_EVENTS, {
    connection: { url },
    defaultJobOptions: QUEUE_DEFAULTS,
  });
}

export interface EnqueuePaymentEventInput {
  queue: Queue<PaymentEventJobData>;
  data: PaymentEventJobData;
}

/** Idempotent enqueue: BullMQ ignores a job whose `jobId` already exists. */
export async function enqueuePaymentEvent({ queue, data }: EnqueuePaymentEventInput): Promise<void> {
  await queue.add(QUEUE_NAMES.PAYMENT_EVENTS, data, { jobId: data.eventKey });
}

export interface CreatePaymentEventWorkerInput {
  url: string;
  processor: Processor<PaymentEventJobData>;
}

export function createPaymentEventWorker({ url, processor }: CreatePaymentEventWorkerInput): Worker<PaymentEventJobData> {
  return new Worker<PaymentEventJobData>(QUEUE_NAMES.PAYMENT_EVENTS, processor, {
    connection: { url },
    concurrency: 1,
  });
}

export type PaymentEventJob = Job<PaymentEventJobData, void, string>;

export { Queue, Worker, type Job as BullJob, type Processor as BullProcessor } from 'bullmq';
