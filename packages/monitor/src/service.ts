import { createHash } from 'crypto';
import type { AppLogger } from '../../shared/src/logger';
import { EVENT_STATUS, MESSAGE_STATUS } from '../../shared/src/constants';
import type { AlertDispatcher } from './alert';
import type { RedisCounter } from './counter';

/**
 * Error-spike monitoring. Runs inside the WORKER on a timer and turns database
 * + Redis signals into alerts when thresholds are exceeded:
 *
 *  - failed messages in the window          → agent / WhatsApp send problems
 *  - failed webhook events in the window    → webhook ingestion is breaking
 *  - a backlog of stuck PENDING events      → webhook ingestion is stalling
 *  - AI error counter in the window         → Gemini errors are spiking
 *
 * Alerts are deduplicated per problem fingerprint for `alertCooldownMs`, so a
 * persistent outage alerts once instead of spamming every check.
 */

/** The subset of Prisma that the monitor needs (keeps this decoupled + testable). */
export interface MonitorDb {
  message: {
    count(args: { where: { status: string; createdAt: { gte: Date } } }): Promise<number>;
  };
  incomingEvent: {
    count(args: { where: { status: string; createdAt: { gte?: Date; lt?: Date } } }): Promise<number>;
  };
}

export interface MonitorRedis {
  /** Atomically claim a cooldown slot: true only for the first caller within ttl. */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface MonitorConfig {
  windowMs: number;
  failedMessagesThreshold: number;
  failedEventsThreshold: number;
  pendingBacklogAgeMs: number;
  pendingBacklogThreshold: number;
  aiErrorThreshold: number;
  alertCooldownMs: number;
}

export interface MonitorDeps {
  db: MonitorDb;
  redis: MonitorRedis;
  counter: RedisCounter;
  alert: AlertDispatcher;
  logger: AppLogger;
  config: MonitorConfig;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface MonitorChecks {
  failedMessages: number;
  failedEvents: number;
  pendingBacklog: number;
  aiErrors: number;
}

export interface MonitorReport {
  checks: MonitorChecks;
  healthy: boolean;
  problems: string[];
}

export interface Monitor {
  runCheck(): Promise<MonitorReport>;
}

export function createMonitor(deps: MonitorDeps): Monitor {
  const { config, logger } = deps;

  async function runCheck(): Promise<MonitorReport> {
    const now = deps.now?.() ?? Date.now();
    const since = new Date(now - config.windowMs);
    const backlogBefore = new Date(now - config.pendingBacklogAgeMs);

    const [failedMessages, failedEvents, pendingBacklog, aiErrors] = await Promise.all([
      deps.db.message.count({ where: { status: MESSAGE_STATUS.FAILED, createdAt: { gte: since } } }),
      deps.db.incomingEvent.count({ where: { status: EVENT_STATUS.FAILED, createdAt: { gte: since } } }),
      deps.db.incomingEvent.count({ where: { status: EVENT_STATUS.PENDING, createdAt: { lt: backlogBefore } } }),
      deps.counter.read('ai.error', now - config.windowMs),
    ]);

    const checks: MonitorChecks = { failedMessages, failedEvents, pendingBacklog, aiErrors };
    const problems: string[] = [];

    if (failedMessages >= config.failedMessagesThreshold) {
      problems.push(`${failedMessages} message(s) FAILED in the last ${minutes(config.windowMs)} min`);
    }
    if (failedEvents >= config.failedEventsThreshold) {
      problems.push(`${failedEvents} webhook event(s) FAILED in the last ${minutes(config.windowMs)} min`);
    }
    if (pendingBacklog >= config.pendingBacklogThreshold) {
      problems.push(`${pendingBacklog} webhook event(s) stuck PENDING for over ${minutes(config.pendingBacklogAgeMs)} min`);
    }
    if (aiErrors >= config.aiErrorThreshold) {
      problems.push(`${aiErrors} AI API error(s) in the last ${minutes(config.windowMs)} min`);
    }

    const healthy = problems.length === 0;
    if (!healthy) {
      await alertIfDue(problems, checks);
    }
    return { checks, healthy, problems };
  }

  async function alertIfDue(problems: string[], checks: MonitorChecks): Promise<void> {
    const fingerprint = problems.join(' | ');
    const dedupKey = `monitor:alerted:${createHash('sha1').update(fingerprint).digest('hex')}`;
    const claimed = await deps.redis.claimOnce(dedupKey, cooldownSeconds());
    if (!claimed) return;

    const lines = [
      `Business: ${checksToString(checks)}`,
      '',
      ...problems.map((p) => `• ${p}`),
      '',
      `Window: last ${minutes(config.windowMs)} min.`,
      'Kill switch: POST /admin/ops/kill-switch {"enabled":true} (see docs/RUNBOOK.md).',
    ];
    logger.warn('monitor alert dispatched', { problems });
    await deps.alert.send({ severity: 'warning', title: 'WhatsApp AI Business OS — alert', body: lines.join('\n') });
  }

  function cooldownSeconds(): number {
    return Math.max(60, Math.ceil(config.alertCooldownMs / 1000));
  }

  return { runCheck };
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function checksToString(checks: MonitorChecks): string {
  const parts = [
    `failed_messages=${checks.failedMessages}`,
    `failed_events=${checks.failedEvents}`,
    `pending_backlog=${checks.pendingBacklog}`,
    `ai_errors=${checks.aiErrors}`,
  ];
  return parts.join(' ');
}