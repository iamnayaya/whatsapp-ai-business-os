import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AppLogger } from '../../shared/src/logger';
import { AppError } from '../../shared/src/errors';
import { withRetry } from '../../shared/src/retry';
import type { InitializeTransactionInput, InitializeTransactionResult } from './types';

export interface PaystackClientConfig {
  secretKey: string;
  baseUrl?: string;
  logger: AppLogger;
  http?: AxiosInstance;
}

/** The seam the AI tools / payment service depend on — trivially faked in tests. */
export interface PaystackLike {
  initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult>;
}

export class PaystackApiError extends AppError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly paystackMessage?: string,
    retryable = false,
  ) {
    super(message, 'PAYSTACK_API_ERROR', retryable);
    this.name = 'PaystackApiError';
  }
}

interface InitializeResponse {
  status: boolean;
  message: string;
  data?: { authorization_url?: string; access_code?: string; reference?: string };
}

/**
 * Thin Paystack REST client. Only the operations we need: initialize a
 * transaction (payment link) and, via the webhook, verify signatures. Amounts
 * are ALWAYS converted to kobo at the call site from the DB order total —
 * this client never accepts a free-form amount string.
 */
export class PaystackClient implements PaystackLike {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly logger: AppLogger;

  constructor(config: PaystackClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.paystack.co').replace(/\/$/, '');
    this.secretKey = config.secretKey;
    this.logger = config.logger;
    this.http = config.http ?? axios.create({});
  }

  async initializeTransaction(input: InitializeTransactionInput): Promise<InitializeTransactionResult> {
    const res = await withRetry(
      async () =>
        this.request<InitializeResponse>({
          method: 'POST',
          url: `${this.baseUrl}/transaction/initialize`,
          data: {
            amount: input.amountKobo,
            email: input.email,
            reference: input.reference,
            currency: input.currency,
            ...(input.metadata ? { metadata: input.metadata } : {}),
          },
        }),
      { logger: this.logger, attempts: 3, shouldRetry: (err) => err instanceof PaystackApiError && err.retryable },
    );

    if (!res.data?.authorization_url || !res.data?.access_code) {
      throw new PaystackApiError('Paystack initialize returned no authorization url', undefined, res.message);
    }

    return {
      reference: res.data.reference ?? input.reference,
      accessCode: res.data.access_code,
      authorizationUrl: res.data.authorization_url,
    };
  }

  private async request<T>(opts: { method: string; url: string; data?: unknown }): Promise<T> {
    try {
      const res = await this.http.request<T>({
        method: opts.method,
        url: opts.url,
        data: opts.data,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/json',
        },
      });
      return res.data;
    } catch (err) {
      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const retryable = !err.response || status === 429 || (status ?? 0) >= 500;
        throw new PaystackApiError(
          `Paystack request failed: ${err.message}`,
          status,
          (err.response?.data as { message?: string })?.message,
          retryable,
        );
      }
      throw err;
    }
  }
}

export function createPaystackClient(config: PaystackClientConfig): PaystackClient {
  return new PaystackClient(config);
}