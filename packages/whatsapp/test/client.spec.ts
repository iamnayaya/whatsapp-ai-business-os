import { describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';
import { WhatsAppClient } from '../src/client';
import { createLogger } from '../../shared/src/logger';
import { WhatsAppApiError } from '../../shared/src/errors';

const silentLogger = createLogger('test', { destination: () => undefined });

function makeClient(http: Partial<AxiosInstance>) {
  return new WhatsAppClient({
    accessToken: 'tok',
    phoneNumberId: 'PNID',
    apiVersion: 'v21.0',
    logger: silentLogger,
    http: http as AxiosInstance,
    retry: { attempts: 1 },
  });
}

describe('WhatsAppClient', () => {
  it('sendText posts a text message and returns the wa message id', async () => {
    const http = { request: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.out.1' }] } }) };
    const client = makeClient(http);
    const result = await client.sendText('2348012345678', 'Hello!');
    expect(result.waMessageId).toBe('wamid.out.1');
    const call = http.request.mock.calls[0][0];
    expect(call.url).toBe('https://graph.facebook.com/v21.0/PNID/messages');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call.data).toMatchObject({ to: '2348012345678', type: 'text' });
  });

  it('markMessageRead posts a read receipt', async () => {
    const http = { request: vi.fn().mockResolvedValue({ data: {} }) };
    const client = makeClient(http);
    await client.markMessageRead('wamid.in.1');
    const call = http.request.mock.calls[0][0];
    expect(call.data).toMatchObject({ status: 'read', message_id: 'wamid.in.1' });
  });

  it('sendTemplate posts a template message with components', async () => {
    const http = { request: vi.fn().mockResolvedValue({ data: { messages: [{ id: 'wamid.tpl.1' }] } }) };
    const client = makeClient(http);
    const result = await client.sendTemplate('2348012345678', {
      name: 'order_update',
      language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Amina' }] }],
    });
    expect(result.waMessageId).toBe('wamid.tpl.1');
    const call = http.request.mock.calls[0][0];
    expect(call.data).toMatchObject({ to: '2348012345678', type: 'template' });
    expect(call.data.template.name).toBe('order_update');
    expect(call.data.template.components[0].parameters[0].text).toBe('Amina');
  });

  it('classifies HTTP 429 as retryable', async () => {
    const http = {
      request: vi.fn().mockRejectedValue({ response: { status: 429, data: { error: { message: 'rate limit' } } } }),
    };
    const client = makeClient(http);
    await expect(client.sendText('2348012345678', 'x')).rejects.toMatchObject({
      retryable: true,
      status: 429,
    });
  });

  it('classifies HTTP 401 as non-retryable (config error, fail fast)', async () => {
    const http = {
      request: vi.fn().mockRejectedValue({ response: { status: 401, data: { error: { message: 'bad token' } } } }),
    };
    const client = makeClient(http);
    await expect(client.sendText('2348012345678', 'x')).rejects.toMatchObject({
      retryable: false,
      status: 401,
    });
  });

  it('classifies a network failure as retryable', async () => {
    const http = { request: vi.fn().mockRejectedValue({ code: 'ECONNRESET' }) };
    const client = makeClient(http);
    await expect(client.sendText('2348012345678', 'x')).rejects.toBeInstanceOf(WhatsAppApiError);
  });

  it('downloadMedia fetches via the media URL with Bearer auth', async () => {
    const http = {
      request: vi.fn().mockResolvedValueOnce({ data: { url: 'https://cdn.example/media/abc', mime_type: 'audio/ogg' } }),
      get: vi.fn().mockResolvedValue({ data: new ArrayBuffer(8) }),
    };
    const client = makeClient(http);
    const media = await client.downloadMedia('MEDIA_1');
    expect(media.mimeType).toBe('audio/ogg');
    expect(media.buffer).toBeInstanceOf(Buffer);
    expect(http.get.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
});