import 'dotenv/config';
import Redis from 'ioredis';
import { loadEnv, createLogger, EVENT_STATUS, QUEUE_NAMES, messageFromError, type Env } from '../../../packages/shared/src';
import { createPrismaClient } from '../../../packages/db/src';
import { createAuditService } from '../../../packages/audit/src';
import {
  createWhatsappMessageWorker,
  createFollowUpScanQueue,
  scheduleFollowUpScan,
  createFollowUpScanWorker,
  createPaymentEventWorker,
} from '../../../packages/queue/src';
import { createWhatsAppClient } from '../../../packages/whatsapp/src';
import { createPaystackClient } from '../../../packages/paystack/src';
import { createPaymentService } from '../../../packages/payment/src';
import { createLlmClient, GeminiTranscriber, AgentOrchestrator } from '../../../packages/ai/src';
import { createFollowUpService, type FollowUpConfig } from '../../../packages/followup/src';
import { createKillSwitch } from '../../../packages/ops/src';
import {
  createMonitor,
  createRedisCounter,
  createAlertDispatcher,
  type MonitorConfig,
  type SmtpConfig,
} from '../../../packages/monitor/src';
import { handleInboundMessage } from './handler';

/** Builds the optional SMTP channel when all required email vars are present. */
function smtpFromEnv(env: Env): SmtpConfig | undefined {
  if (!env.ALERT_SMTP_HOST || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) return undefined;
  return {
    host: env.ALERT_SMTP_HOST,
    port: env.ALERT_SMTP_PORT ?? 587,
    secure: env.ALERT_SMTP_SECURE,
    user: env.ALERT_SMTP_USER,
    pass: env.ALERT_SMTP_PASS,
    from: env.ALERT_EMAIL_FROM,
    to: env.ALERT_EMAIL_TO,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    throw new Error('At least one LLM provider key is required (GROQ_API_KEY or GEMINI_API_KEY)');
  }
  const logger = createLogger('worker');
  const prisma = createPrismaClient();
  const audit = createAuditService({ prisma, logger });
  const whatsapp = createWhatsAppClient({
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    apiVersion: env.WHATSAPP_API_VERSION,
    logger: logger.child('whatsapp'),
  });

  // Phase 9 — ops Redis connection shared by the kill switch, the AI error
  // counter, and the monitor's alert-dedup. BullMQ opens its own connections.
  const opsRedis = new Redis(env.REDIS_URL);
  opsRedis.on('error', (err) => logger.error('ops redis error', { error: messageFromError(err) }));
  const killSwitch = createKillSwitch({ redis: opsRedis, logger: logger.child('ops') });

  const aiErrorCounter = createRedisCounter({
    redis: opsRedis,
    prefix: 'monitor:count',
    bucketMs: env.MONITOR_WINDOW_MINUTES * 60_000,
  });

  const monitor = createMonitor({
    db: prisma,
    redis: {
      // Atomically claim a cooldown slot (SET key EX ttl NX) so a persistent
      // problem alerts once per cooldown even across multiple worker replicas.
      claimOnce: async (key, ttlSeconds) => (await opsRedis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK',
    },
    counter: aiErrorCounter,
    alert: createAlertDispatcher({
      slack: env.SLACK_WEBHOOK_URL ? { webhookUrl: env.SLACK_WEBHOOK_URL } : undefined,
      email: smtpFromEnv(env),
      logger: logger.child('alert'),
    }),
    logger: logger.child('monitor'),
    config: {
      windowMs: env.MONITOR_WINDOW_MINUTES * 60_000,
      failedMessagesThreshold: env.MONITOR_FAILED_MESSAGES_THRESHOLD,
      failedEventsThreshold: env.MONITOR_FAILED_EVENTS_THRESHOLD,
      pendingBacklogAgeMs: env.MONITOR_PENDING_BACKLOG_MINUTES * 60_000,
      pendingBacklogThreshold: env.MONITOR_PENDING_BACKLOG_THRESHOLD,
      aiErrorThreshold: env.MONITOR_AI_ERROR_THRESHOLD,
      alertCooldownMs: env.MONITOR_ALERT_COOLDOWN_MINUTES * 60_000,
    } satisfies MonitorConfig,
  });

  const llm = createLlmClient({
    groqApiKey: env.GROQ_API_KEY,
    groqModel: env.GROQ_MODEL,
    groqBaseUrl: env.GROQ_BASE_URL,
    groqVisionModel: env.GROQ_VISION_MODEL,
    groqAudioModel: env.GROQ_AUDIO_MODEL,
    visionApiKey: env.VISION_API_KEY,
    visionBaseUrl: env.VISION_BASE_URL,
    visionModel: env.VISION_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    logger: logger.child('llm'),
    // Fire-and-forget counter increment so a provider outage surfaces as an
    // alert (AI error spike) even when the queue's own retries mask it.
    onError: () => {
      void aiErrorCounter.inc('ai.error').catch(() => undefined);
    },
  });
  // Phase 7 — Paystack client for the create_payment_link tool. When the secret
  // key is missing the tool refuses to generate links (fail-closed).
  const paystack = env.PAYSTACK_SECRET_KEY
    ? createPaystackClient({
        secretKey: env.PAYSTACK_SECRET_KEY,
        baseUrl: env.PAYSTACK_BASE_URL,
        logger: logger.child('paystack'),
      })
    : undefined;
  // Phase 6 — multi-agent orchestration: routes each message to a specialized
  // sales/support/logistics agent that share one history and the same tools.
  const agent = new AgentOrchestrator({
    llm,
    prisma,
    audit,
    logger: logger.child('agent'),
    refundThreshold: env.REFUND_ESCALATION_THRESHOLD,
    paystack,
  });
  const transcriber = new GeminiTranscriber(
    llm,
    env.TRANSCRIBER_MIN_CONFIDENCE !== undefined ? { minConfidence: env.TRANSCRIBER_MIN_CONFIDENCE } : undefined,
  );

  const concurrency = 5;
  const worker = createWhatsappMessageWorker({
    url: env.REDIS_URL,
    concurrency,
    processor: (job) => handleInboundMessage(job, { prisma, audit, logger, whatsapp, agent, transcriber, killSwitch }),
  });

  worker.on('failed', (job, err) => {
    logger.error('job failed', { jobId: job?.id, error: err.message, attemptsMade: job?.attemptsMade });
  });
  worker.on('error', (err) => {
    logger.error('worker error', { error: err.message });
  });

  // Phase 5 — abandoned-cart follow-up scan (BullMQ repeatable cron job).
  const followUpConfig: FollowUpConfig = {
    firstDelayMs: env.FOLLOWUP_FIRST_DELAY_MINUTES * 60_000,
    secondDelayMs: env.FOLLOWUP_SECOND_DELAY_MINUTES * 60_000,
    maxAttempts: env.FOLLOWUP_MAX_ATTEMPTS,
    quietStartHour: env.FOLLOWUP_QUIET_START,
    quietEndHour: env.FOLLOWUP_QUIET_END,
  };
  const followUpService = createFollowUpService({
    prisma,
    whatsapp,
    audit,
    logger: logger.child('followup'),
    config: followUpConfig,
  });
  const followUpScanQueue = createFollowUpScanQueue({ url: env.REDIS_URL });
  await scheduleFollowUpScan({ queue: followUpScanQueue, cron: env.FOLLOWUP_SCAN_CRON });

  const followUpWorker = createFollowUpScanWorker({
    url: env.REDIS_URL,
    processor: async () => {
      const summary = await followUpService.runScan();
      logger.info('follow-up scan complete', { summary });
    },
  });
  followUpWorker.on('failed', (job, err) => {
    logger.error('follow-up scan failed', { jobId: job?.id, error: err.message, attemptsMade: job?.attemptsMade });
  });
  followUpWorker.on('error', (err) => {
    logger.error('follow-up worker error', { error: err.message });
  });

  // Phase 7 — payment events: charge.success / charge.failed processed off the
  // webhook hot path. Concurrency 1 keeps per-order claims serialized.
  const paymentService = createPaymentService({
    prisma,
    whatsapp,
    audit,
    logger: logger.child('payment'),
  });
  const paymentWorker = createPaymentEventWorker({
    url: env.REDIS_URL,
    processor: async (job) => {
      const outcome = await paymentService.handleChargeEvent({ event: job.data.event, data: job.data.data });
      // Mark the raw event PROCESSED only after the business work completes, so
      // a crash mid-processing leaves a visible unprocessed backlog.
      await prisma.incomingEvent
        .updateMany({
          where: { eventKey: job.data.eventKey, status: EVENT_STATUS.PENDING },
          data: { status: EVENT_STATUS.PROCESSED, processedAt: new Date(), attempts: { increment: 1 } },
        })
        .catch((err) => {
          logger.error('failed to mark payment event processed', { eventKey: job.data.eventKey, error: err.message });
        });
      logger.info('payment event processed', { eventKey: job.data.eventKey, event: job.data.event, outcome: outcome.kind });
      return outcome;
    },
  });
  paymentWorker.on('failed', (job, err) => {
    logger.error('payment event failed', { jobId: job?.id, error: err.message, attemptsMade: job?.attemptsMade });
  });
  paymentWorker.on('error', (err) => {
    logger.error('payment worker error', { error: err.message });
  });

  logger.info('worker started', { queue: QUEUE_NAMES.WHATSAPP_MESSAGES, concurrency });
  logger.info('follow-up scan scheduled', { cron: env.FOLLOWUP_SCAN_CRON });
  logger.info('payment events worker started', { queue: QUEUE_NAMES.PAYMENT_EVENTS, paystackConfigured: Boolean(paystack) });

  // Phase 9 — error-spike monitor. Runs in the worker so it can read the same
  // database + Redis it guards. One-off (multi-worker) checks are deduplicated
  // by the Redis NX cooldown key inside the monitor.
  let monitorTimer: NodeJS.Timeout | undefined;
  if (env.MONITOR_ENABLED) {
    const runCheck = () =>
      monitor
        .runCheck()
        .then((report) => {
          if (!report.healthy) {
            logger.warn('monitor found problems', { problems: report.problems, checks: report.checks });
          }
        })
        .catch((err) => logger.error('monitor check failed', { error: messageFromError(err) }));
    const intervalMs = env.MONITOR_INTERVAL_MINUTES * 60_000;
    setTimeout(runCheck, 5_000);
    monitorTimer = setInterval(runCheck, intervalMs);
    logger.info('monitor started', { intervalMs });
  }

  const shutdown = async (signal: string) => {
    try {
      logger.info(`shutting down (${signal})`);
      if (monitorTimer) clearInterval(monitorTimer);
      await worker.close();
      await followUpWorker.close();
      await followUpScanQueue.close();
      await paymentWorker.close();
      await opsRedis.quit();
      await prisma.$disconnect();
    } catch (err) {
      logger.error('error during shutdown', { error: messageFromError(err) });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  const logger = createLogger('worker-main');
  logger.error('worker failed to start', { error: messageFromError(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
