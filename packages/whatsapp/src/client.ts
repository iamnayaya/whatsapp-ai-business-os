import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { AppLogger } from '../../shared/src/logger';
import { WhatsAppApiError } from '../../shared/src/errors';
import { withRetry } from '../../shared/src/retry';

export interface WhatsAppClientConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  logger: AppLogger;
  http?: AxiosInstance;
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}

export interface SendTextOptions {
  previewUrl?: boolean;
}

export interface TemplateParameter {
  type: 'text' | 'image' | 'video' | 'document' | 'location' | 'currency' | 'date_time' | 'button';
  text?: string;
  image?: { link: string } | { id: string };
  video?: { link: string } | { id: string };
  document?: { link: string } | { id: string };
  [key: string]: unknown;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button' | 'carousel' | 'limited_time_offer';
  parameters?: TemplateParameter[];
  sub_type?: string;
  index?: string | number;
}

export interface TemplatePayload {
  name: string;
  language: { code: string };
  components?: TemplateComponent[];
}

export interface MediaDownload {
  buffer: Buffer;
  mimeType: string;
}

interface AxiosErrorLike {
  response?: { status?: number; data?: unknown };
  request?: unknown;
  code?: string;
}

export class WhatsAppClient {
  private readonly http: AxiosInstance;
  private readonly baseUrl: string;

  constructor(private readonly config: WhatsAppClientConfig) {
    this.baseUrl = `https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}`;
    this.http = config.http ?? axios.create({});
  }

  async sendText(to: string, body: string, opts: SendTextOptions = {}): Promise<{ waMessageId: string }> {
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: opts.previewUrl ?? false, body },
    };
    const res = await this.request<{ messages: Array<{ id: string }> }>({
      method: 'POST',
      url: `${this.baseUrl}/messages`,
      data,
      context: { operation: 'sendText', to },
    });
    return { waMessageId: res.messages?.[0]?.id };
  }

  async markMessageRead(messageId: string): Promise<void> {
    await this.request({
      method: 'POST',
      url: `${this.baseUrl}/messages`,
      data: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      context: { operation: 'markMessageRead', messageId },
    });
  }

  async sendTemplate(to: string, template: TemplatePayload): Promise<{ waMessageId: string }> {
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template,
    };
    const res = await this.request<{ messages: Array<{ id: string }> }>({
      method: 'POST',
      url: `${this.baseUrl}/messages`,
      data,
      context: { operation: 'sendTemplate', to, templateName: template.name },
    });
    return { waMessageId: res.messages?.[0]?.id };
  }

  async getMediaUrl(mediaId: string): Promise<{ url: string; mimeType?: string }> {
    const res = await this.request<{ url: string; mime_type?: string }>({
      method: 'GET',
      url: `https://graph.facebook.com/${this.config.apiVersion}/${mediaId}`,
      context: { operation: 'getMediaUrl', mediaId },
    });
    return { url: res.url, mimeType: res.mime_type };
  }

  async downloadMedia(mediaId: string): Promise<MediaDownload> {
    const { url, mimeType } = await this.getMediaUrl(mediaId);
    const res = await this.http.get<ArrayBuffer>(url, {
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      responseType: 'arraybuffer',
    });
    return { buffer: Buffer.from(res.data), mimeType: mimeType ?? 'application/octet-stream' };
  }

  private async request<T>(opts: {
    method: 'POST' | 'GET';
    url: string;
    data?: unknown;
    context: Record<string, unknown>;
  }): Promise<T> {
    const { logger } = this.config;
    const retry = this.config.retry ?? {};
    return withRetry(
      async () => {
        try {
          const res = await this.http.request<T>({
            method: opts.method,
            url: opts.url,
            data: opts.data,
            headers: {
              Authorization: `Bearer ${this.config.accessToken}`,
              'Content-Type': 'application/json',
            },
          });
          return res.data;
        } catch (err) {
          throw this.classifyError(err, opts.context);
        }
      },
      {
        attempts: retry.attempts ?? 5,
        baseDelayMs: retry.baseDelayMs ?? 1_000,
        maxDelayMs: retry.maxDelayMs ?? 30_000,
        logger,
        shouldRetry: (err) => (err instanceof WhatsAppApiError ? err.retryable : true),
      },
    );
  }

  private classifyError(err: unknown, context: Record<string, unknown>): WhatsAppApiError {
    if (err instanceof WhatsAppApiError) return err;
    const axiosErr = err as AxiosErrorLike & AxiosError;
    const status = axiosErr.response?.status;
    const fb = this.parseFbError(axiosErr.response?.data);

    if (status === 429 || (status !== undefined && status >= 500)) {
      this.config.logger.warn('whatsapp.api retryable error', { ...context, status, fbError: fb });
      return new WhatsAppApiError(fb?.message ?? `WhatsApp API error (HTTP ${status})`, status, fb, true);
    }
    if (status !== undefined) {
      this.config.logger.error('whatsapp.api non-retryable error', { ...context, status, fbError: fb });
      return new WhatsAppApiError(fb?.message ?? `WhatsApp API error (HTTP ${status})`, status, fb, false);
    }
    // Network-level failure: request made, no response.
    this.config.logger.warn('whatsapp.api network error', { ...context, code: axiosErr.code });
    return new WhatsAppApiError(axiosErr.code ?? 'NETWORK_ERROR', undefined, undefined, true);
  }

  private parseFbError(data: unknown): { code?: number; subcode?: number; message?: string } | undefined {
    const error = (data as { error?: { code?: number; error_subcode?: number; message?: string } } | undefined)?.error;
    if (!error) return undefined;
    return { code: error.code, subcode: error.error_subcode, message: error.message };
  }
}

export function createWhatsAppClient(config: WhatsAppClientConfig): WhatsAppClient {
  return new WhatsAppClient(config);
}
