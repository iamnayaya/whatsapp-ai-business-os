import { describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import type { AxiosInstance } from 'axios';
import { PaystackClient, PaystackApiError } from '../src/client';
import { createLogger } from '../../shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

function makeClient(http: unknown) {
  return new PaystackClient({
    secretKey: 'sk_test_x',
    baseUrl: 'https://api.paystack.co',
    logger: silentLogger,
    http: http as AxiosInstance,
  });
}

function okResponse(over: Partial<Record<string, unknown>> = {}) {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
    data: {
      status: true,
      message: 'Authorization URL created',
      data: {
        authorization_url: 'https://checkout.paystack.com/xyz',
        access_code: 'ac_xyz',
        reference: 'ref-1',
      },
      ...over,
    },
  };
}

function axiosError(status: number | undefined, data?: unknown): AxiosError {
  const response: AxiosResponse | undefined =
    status === undefined
      ? undefined
      : {
          status,
          statusText: String(status),
          headers: {},
          config: { headers: {} } as never,
          data: data ?? { message: 'boom' },
        };
  return new AxiosError(
    status === undefined ? 'Network Error' : `Request failed ${status}`,
    status === undefined ? 'ECONNRESET' : 'ERR_BAD_RESPONSE',
    undefined,
    undefined,
    response,
  );
}

const input = { amountKobo: 5000000, email: 'a@b.co', reference: 'ref-1', currency: 'NGN' };

describe('PaystackClient.initializeTransaction', () => {
  it('returns the authorization url / access code on success', async () => {
    const http = { request: vi.fn().mockResolvedValue(okResponse()) };
    const client = makeClient(http);
    const res = await client.initializeTransaction(input);
    expect(res).toEqual({
      reference: 'ref-1',
      accessCode: 'ac_xyz',
      authorizationUrl: 'https://checkout.paystack.com/xyz',
    });
    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request.mock.calls[0][0].headers.Authorization).toBe('Bearer sk_test_x');
  });

  it('retries a network error (no response) then succeeds', async () => {
    const http = {
      request: vi
        .fn()
        .mockRejectedValueOnce(axiosError(undefined))
        .mockResolvedValueOnce(okResponse()),
    };
    const client = makeClient(http);
    vi.useFakeTimers();
    try {
      const pending = client.initializeTransaction(input);
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.reference).toBe('ref-1');
    } finally {
      vi.useRealTimers();
    }
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx error then succeeds', async () => {
    const http = {
      request: vi
        .fn()
        .mockRejectedValueOnce(axiosError(500))
        .mockResolvedValueOnce(okResponse()),
    };
    const client = makeClient(http);
    vi.useFakeTimers();
    try {
      const pending = client.initializeTransaction(input);
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.reference).toBe('ref-1');
    } finally {
      vi.useRealTimers();
    }
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx error (e.g. invalid secret key)', async () => {
    const http = { request: vi.fn().mockRejectedValue(axiosError(401, { message: 'Unauthorized' })) };
    const client = makeClient(http);
    await expect(client.initializeTransaction(input)).rejects.toMatchObject({
      name: 'PaystackApiError',
      status: 401,
      retryable: false,
    });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('tags retryable errors so the shared retry policy can act on them', async () => {
    const networkErr = axiosError(undefined);
    const fiveHundred = axiosError(500);
    const fourOhOne = axiosError(401);
    try {
      throw new PaystackApiError('x', networkErr.status);
    } catch (err) {
      expect((err as PaystackApiError).retryable).toBe(false);
    }
    vi.useFakeTimers();
    try {
      const rejected = (err: AxiosError) => {
        const client = makeClient({ request: vi.fn().mockRejectedValue(err) });
        return client.initializeTransaction(input);
      };
      const networkCall = rejected(networkErr);
      const fiveHundredCall = rejected(fiveHundred);
      const fourOhOneCall = rejected(fourOhOne);
      const networkCheck = expect(networkCall).rejects.toMatchObject({ retryable: true });
      const fiveHundredCheck = expect(fiveHundredCall).rejects.toMatchObject({ retryable: true });
      const fourOhOneCheck = expect(fourOhOneCall).rejects.toMatchObject({ retryable: false });
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([networkCheck, fiveHundredCheck, fourOhOneCheck]);
    } finally {
      vi.useRealTimers();
    }
  });
});