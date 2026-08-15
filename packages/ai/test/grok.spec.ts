import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../shared/src';
import { GrokClient, GrokApiError, grokErrorMessage } from '../src/grok';
import { createLlmClient } from '../src/factory';
import type { GeminiTurn } from '../src/client';

const silentLogger = createLogger('grok-test', { destination: () => undefined });

function makeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return vi.fn(async (input: string, init: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  });
}

const TOOLS = [
  {
    name: 'search_products',
    description: 'Search the catalog',
    parameters: { type: 'OBJECT' as const, properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

describe('GrokClient.generate', () => {
  it('translates Gemini turns to OpenAI messages and parses the reply', async () => {
    const fetchFn = makeFetch((url, init) => {
      expect(url).toBe('https://api.x.ai/v1/chat/completions');
      const body = JSON.parse(String(init.body)) as {
        model?: string;
        messages: Array<{ role: string; content: string | null; tool_calls?: unknown[] }>;
        tools?: unknown[];
      };
      expect(body.model).toBe('grok-4.6');
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a seller.' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Hi' });
      expect(body.messages[2]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search_products', arguments: '{"query":"carpet"}' } },
        ],
      });
      expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"results":[]}' });
      expect(body.tools?.[0]).toEqual({
        type: 'function',
        function: {
          name: 'search_products',
          description: 'Search the catalog',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      });
      return {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: 'We are out of carpets.',
                tool_calls: [
                  {
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'search_products', arguments: '{"query":"rug"}' },
                  },
                ],
              },
            },
          ],
        },
      };
    });

    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });
    const contents: GeminiTurn[] = [
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ functionCall: { name: 'search_products', args: { query: 'carpet' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'search_products', response: { results: [] } } }] },
    ];

    const result = await client.generate({ contents, systemInstruction: 'You are a seller.', tools: TOOLS });
    expect(result).toEqual({
      text: 'We are out of carpets.',
      functionCalls: [{ name: 'search_products', args: { query: 'rug' } }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('merges consecutive same-role text parts', async () => {
    const fetchFn = makeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string | null }> };
      expect(body.messages).toEqual([{ role: 'user', content: 'one\ntwo' }]);
      return { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    });
    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });
    const result = await client.generate({
      contents: [{ role: 'user', parts: [{ text: 'one' }, { text: 'two' }] }],
      systemInstruction: '',
      tools: [],
    });
    expect(result.text).toBe('ok');
  });

  it('omits tools from the payload when none are declared', async () => {
    const fetchFn = makeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { tools?: unknown[]; tool_choice?: unknown };
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    });
    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });
    await client.generate({ contents: [], systemInstruction: '', tools: [] });
  });

  it('retries on 429 and fires onError, then fails with a retryable error', async () => {
    const onError = vi.fn();
    const fetchFn = makeFetch(() => ({
      status: 429,
      body: { error: { message: 'Rate limit exceeded' } },
    }));
    const client = new GrokClient({
      apiKey: 'test-key',
      model: 'grok-4.6',
      logger: silentLogger,
      fetchFn,
      onError,
      retry: { attempts: 5, baseDelayMs: 2, maxDelayMs: 8 },
    });

    await expect(
      client.generate({ contents: [], systemInstruction: '', tools: [] }),
    ).rejects.toSatisfy((err: unknown) => err instanceof GrokApiError && err.retryable === true);

    expect(fetchFn).toHaveBeenCalledTimes(5);
    expect(onError).toHaveBeenCalledTimes(5);
    expect(grokErrorMessage(new GrokApiError('boom'))).toBe('boom');
  });

  it('fails fast on 400 without retrying', async () => {
    const fetchFn = makeFetch(() => ({ status: 400, body: { error: { message: 'bad request' } } }));
    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });

    await expect(
      client.generate({ contents: [], systemInstruction: '', tools: [] }),
    ).rejects.toSatisfy((err: unknown) => err instanceof GrokApiError && err.retryable === false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('GrokClient.analyzeImage / transcribeAudio', () => {
  it('sends the image as a data URL', async () => {
    const fetchFn = makeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown[] }> };
      const content = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
      expect(content[1].type).toBe('image_url');
      expect(content[1].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
      return { status: 200, body: { choices: [{ message: { content: '{"usable":true}' } }] } };
    });
    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });
    const result = await client.analyzeImage({
      buffer: Buffer.from('img'),
      mimeType: 'image/jpeg',
      prompt: 'List this product',
    });
    expect(result.text).toBe('{"usable":true}');
  });

  it('uses the visionModel override for image calls when set', async () => {
    const fetchFn = makeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { model: string };
      expect(body.model).toBe('Qwen/Qwen3-VL-30B-A3B-Instruct');
      return { status: 200, body: { choices: [{ message: { content: 'ok' } }] } };
    });
    const client = new GrokClient({
      apiKey: 'test-key',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      visionModel: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
      logger: silentLogger,
      fetchFn,
    });
    await client.analyzeImage({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
  });

  it('routes voice notes through the HF Router transcription endpoint', async () => {
    const fetchFn = makeFetch((url, init) => {
      expect(url).toBe('https://router.huggingface.co/v1/audio/transcriptions');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
      const headers = new Headers(init.headers);
      expect(String(headers.get('Authorization') ?? '')).toContain('Bearer');
      return { status: 200, body: { text: 'salaam bani' } };
    });
    const client = new GrokClient({
      apiKey: 'hf-test',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      baseUrl: 'https://router.huggingface.co/v1',
      logger: silentLogger,
      fetchFn,
    });
    const result = await client.transcribeAudio({ buffer: Buffer.from('aud'), mimeType: 'audio/wav' });
    expect(result.text).toBe('salaam bani');
    expect(result.functionCalls).toEqual([]);
  });

  it('maps the mime type to an audio format for the input_audio part', async () => {
    const fetchFn = makeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown[] }> };
      const content = body.messages[0].content as Array<{ type: string; input_audio?: { format: string } }>;
      expect(content[1].type).toBe('input_audio');
      expect(content[1].input_audio?.format).toBe('wav');
      return { status: 200, body: { choices: [{ message: { content: '{"text":"salaam"}' } }] } };
    });
    const client = new GrokClient({ apiKey: 'test-key', model: 'grok-4.6', logger: silentLogger, fetchFn });
    const result = await client.transcribeAudio({ buffer: Buffer.from('aud'), mimeType: 'audio/wav' });
    expect(result.text).toBe('{"text":"salaam"}');
  });
});

describe('createLlmClient', () => {
  it('throws when no provider key is configured', () => {
    expect(() => createLlmClient({ logger: silentLogger })).toThrow(/GROQ_API_KEY or GEMINI_API_KEY/);
  });

  it('uses Groq for conversations, vision and voice when only GROQ_API_KEY is set', async () => {
    const fetchFn = makeFetch((url, init) => {
      expect(String(url)).toContain('api.groq.com');
      if (String(url).includes('/audio/transcriptions')) {
        expect(init.body).toBeInstanceOf(FormData);
        return { status: 200, body: { text: '{"text":"salaam"}' } };
      }
      return { status: 200, body: { choices: [{ message: { content: 'via groq' } }] } };
    });
    const llm = createLlmClient({ groqApiKey: 'gsk-test', logger: silentLogger, fetchFn });

    const result = await llm.generate({ contents: [], systemInstruction: '', tools: [] });
    expect(result.text).toBe('via groq');

    const vision = await llm.analyzeImage({ buffer: Buffer.from('x'), mimeType: 'image/png' });
    expect(vision.text).toBe('via groq');

    const transcript = await llm.transcribeAudio({ buffer: Buffer.from('a'), mimeType: 'audio/wav' });
    expect(transcript.text).toBe('{"text":"salaam"}');
  });

  it('routes vision to a separate provider when VISION_API_KEY is set', async () => {
    const fetchFn = makeFetch((url) => {
      if (String(url).includes('router.huggingface.co')) {
        return { status: 200, body: { choices: [{ message: { content: 'vision via HF' } }] } };
      }
      return { status: 200, body: { choices: [{ message: { content: 'chat via groq' } }] } };
    });
    const llm = createLlmClient({
      groqApiKey: 'gsk-test',
      visionApiKey: 'hf-test',
      visionBaseUrl: 'https://router.huggingface.co/v1',
      visionModel: 'Qwen/Qwen3-VL-30B-A3B-Instruct',
      logger: silentLogger,
      fetchFn,
    });

    const conv = await llm.generate({ contents: [], systemInstruction: '', tools: [] });
    expect(conv.text).toBe('chat via groq');

    const vision = await llm.analyzeImage({ buffer: Buffer.from('x'), mimeType: 'image/png' });
    expect(vision.text).toBe('vision via HF');
  });
});
