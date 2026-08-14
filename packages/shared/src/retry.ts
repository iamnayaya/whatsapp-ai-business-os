import type { AppLogger } from './logger';
import { messageFromError } from './errors';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logger?: AppLogger;
  shouldRetry?: (err: unknown) => boolean;
}

export class RetryExhaustedError extends Error {
  constructor(message: string, public readonly lastError: unknown) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultShouldRetry(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'retryable' in err) {
    return (err as { retryable?: boolean }).retryable === true;
  }
  // Unknown errors are treated as retryable (transient infra issues).
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const logger = opts.logger;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !shouldRetry(err)) {
        throw err;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = delay * (0.5 + Math.random() * 0.5);
      logger?.warn(`retrying attempt ${attempt}/${attempts} in ${Math.round(jittered)}ms`, {
        error: messageFromError(err),
      });
      await sleep(jittered);
    }
  }
  throw new RetryExhaustedError('retries exhausted', lastError);
}