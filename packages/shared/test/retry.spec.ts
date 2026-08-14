import { describe, expect, it } from 'vitest';
import { withRetry } from '../src/retry';

describe('withRetry', () => {
  it('returns the value on the first attempt', async () => {
    await expect(withRetry(async () => 'ok', { attempts: 3 })).resolves.toBe('ok');
  });

  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw { retryable: true };
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw { retryable: true, code: 'E' };
        },
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
      ),
    ).rejects.toMatchObject({ retryable: true, code: 'E' });
    expect(calls).toBe(2);
  });

  it('retries and rethrows non-Error thrown values as-is', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw 'plain-string-error';
      }, { attempts: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toBe('plain-string-error');
    expect(calls).toBe(2);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw { retryable: false };
      }, { attempts: 3 }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toBe(1);
  });
});