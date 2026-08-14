import { describe, expect, it, vi } from 'vitest';
import { createMonitor } from '../src/service';
import { EVENT_STATUS, MESSAGE_STATUS } from '../../shared/src/constants';
import { createLogger } from '../../shared/src/logger';
import type { MonitorRedis } from '../src/service';

const silentLogger = createLogger('test', { destination: () => undefined });

const config = {
  windowMs: 15 * 60_000,
  failedMessagesThreshold: 5,
  failedEventsThreshold: 3,
  pendingBacklogAgeMs: 10 * 60_000,
  pendingBacklogThreshold: 5,
  aiErrorThreshold: 10,
  alertCooldownMs: 30 * 60_000,
};

function makeRedis(active: boolean) {
  const claimOnce = vi.fn(async () => active);
  return { claimOnce } as unknown as MonitorRedis;
}

function makeDeps(overrides: {
  counts?: { failedMessages?: number; failedEvents?: number; pendingBacklog?: number; aiErrors?: number };
  alertActive?: boolean;
} = {}) {
  const counts = overrides.counts ?? { failedMessages: 0, failedEvents: 0, pendingBacklog: 0, aiErrors: 0 };
  const db = {
    message: { count: vi.fn(async () => counts.failedMessages ?? 0) },
    incomingEvent: {
      count: vi.fn(async ({ where }) =>
        where.status === EVENT_STATUS.FAILED ? (counts.failedEvents ?? 0) : (counts.pendingBacklog ?? 0),
      ),
    },
  };
  const counter = { inc: vi.fn(async () => undefined), read: vi.fn(async () => counts.aiErrors ?? 0) };
  const alert = { send: vi.fn(async () => undefined) };
  const redis = makeRedis(overrides.alertActive ?? true);
  const logger = { ...silentLogger, warn: vi.fn() };
  return { db, counter, alert, redis, logger };
}

describe('createMonitor', () => {
  it('reports healthy when all metrics are below their thresholds', async () => {
    const deps = makeDeps();
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    const report = await monitor.runCheck();

    expect(report.healthy).toBe(true);
    expect(report.problems).toEqual([]);
    expect(deps.alert.send).not.toHaveBeenCalled();
  });

  it('alerts when failed messages exceed the threshold', async () => {
    const deps = makeDeps({ counts: { failedMessages: 6 } });
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    const report = await monitor.runCheck();

    expect(report.healthy).toBe(false);
    expect(report.problems[0]).toContain('6 message(s) FAILED');
    expect(deps.alert.send).toHaveBeenCalledTimes(1);
    expect(deps.alert.send).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
  });

  it('alerts when AI errors spike above the threshold', async () => {
    const deps = makeDeps({ counts: { aiErrors: 12 } });
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    await monitor.runCheck();

    expect(deps.alert.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('12 AI API error(s)') }),
    );
  });

  it('alerts on a stuck pending backlog', async () => {
    const deps = makeDeps({ counts: { pendingBacklog: 6 } });
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    await monitor.runCheck();

    expect(deps.alert.send).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('stuck PENDING') }),
    );
  });

  it('deduplicates alerts for the same fingerprint within the cooldown', async () => {
    const deps = makeDeps({ counts: { failedMessages: 9 } });
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    // First check wins the NX slot (alertActive=true), subsequent checks lose.
    const first = makeDeps({ counts: { failedMessages: 9 }, alertActive: true });
    await createMonitor({ ...first, logger: silentLogger, config }).runCheck();
    const second = makeDeps({ counts: { failedMessages: 9 }, alertActive: false });
    await createMonitor({ ...second, logger: silentLogger, config }).runCheck();

    expect(first.alert.send).toHaveBeenCalledTimes(1);
    expect(second.alert.send).not.toHaveBeenCalled();
  });

  it('uses distinct fingerprints so different problems each alert', async () => {
    const claimOnce = vi.fn(async (_key: string, _ttlSeconds: number) => true);
    const redis = { claimOnce } as unknown as MonitorRedis;
    const first = makeDeps({ counts: { failedMessages: 6 } });
    const second = makeDeps({ counts: { aiErrors: 11 } });
    const m1 = createMonitor({ ...first, redis, logger: silentLogger, config });
    const m2 = createMonitor({ ...second, redis, logger: silentLogger, config });

    await m1.runCheck();
    await m2.runCheck();

    // Two distinct problems -> two distinct cooldown keys -> two alerts.
    const keys = new Set(claimOnce.mock.calls.map((c) => c[0]));
    expect(keys.size).toBe(2);
    expect(first.alert.send).toHaveBeenCalledTimes(1);
    expect(second.alert.send).toHaveBeenCalledTimes(1);
  });

  it('surfaces every failed check in one report', async () => {
    const deps = makeDeps({ counts: { failedMessages: 6, failedEvents: 4, pendingBacklog: 6, aiErrors: 11 } });
    const monitor = createMonitor({ ...deps, logger: silentLogger, config });

    const report = await monitor.runCheck();

    expect(report.problems).toHaveLength(4);
    expect(report.checks).toEqual({ failedMessages: 6, failedEvents: 4, pendingBacklog: 6, aiErrors: 11 });
  });
});