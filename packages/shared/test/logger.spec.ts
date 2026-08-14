import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';

function captureLogger(scope: string, opts: Parameters<typeof createLogger>[1] = {}) {
  const lines: string[] = [];
  const logger = createLogger(scope, { ...opts, destination: (line) => lines.push(line) });
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits structured lines with scope and level', () => {
    const { logger, lines } = captureLogger('api');
    logger.info('hello', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('api');
    expect(lines[0]).toContain('hello');
    expect(lines[0]).toContain('"a":1');
  });

  it('filters out levels below the configured threshold', () => {
    const { logger, lines } = captureLogger('worker', { level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('yes');
  });

  it('emits JSON in production format', () => {
    const { logger, lines } = captureLogger('api', { format: 'json' });
    logger.error('boom', { code: 'X' });
    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('error');
    expect(parsed.scope).toBe('api');
    expect(parsed.message).toBe('boom');
    expect(parsed.context.code).toBe('X');
  });

  it('child loggers inherit scope prefix', () => {
    const { logger, lines } = captureLogger('worker');
    logger.child('queue').info('job');
    expect(lines[0]).toContain('worker.queue');
  });
});