import type { AppLogger } from '../../shared/src/logger';
import { messageFromError } from '../../shared/src/errors';
import { withRetry } from '../../shared/src/retry';
import type {
  GeminiFunctionDeclaration,
  GeminiResult,
  GeminiTurn,
  TranscribeAudioOptions,
  AnalyzeImageOptions,
} from './client';

export interface GrokClientConfig {
  apiKey: string;
  model: string;
  /** Base URL of the OpenAI-compatible endpoint. Defaults to the xAI public API. */
  baseUrl?: string;
  /** Optional separate model for vision calls (product-photo → listings). */
  visionModel?: string;
  /**
   * Optional separate model for audio transcription (e.g. whisper on Groq).
   * Defaults to the conversation model.
   */
  audioModel?: string;
  logger: AppLogger;
  /**
   * Optional hook fired once per FAILED generation call (before retry/backoff
   * decisions). Used by the monitoring package to detect AI error spikes.
   */
  onError?: (err: unknown) => void;
  /** Injectable transport (tests). Defaults to the global fetch. */
  fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
  /** Retry tuning overrides (tests use tiny delays; prod defaults are fine). */
  retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
}

/** OpenAI-compatible chat message sent to the provider. */
export type GrokMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null }
  | { role: 'tool'; tool_call_id: string; content: string };

interface GrokToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * OpenAI-compatible LLM client (Groq, xAI, HF Router, …). Implements the SAME
 * internal interface as GeminiClient (`generate`, `transcribeAudio`,
 * `analyzeImage`) so the agent, router and orchestrator never know which
 * provider is behind the seam. The wire format is OpenAI-compatible chat
 * completions — the factory (`createLlmClient`) decides which provider to
 * instantiate from env.
 */
export class GrokClient {
  private readonly baseUrl: string;
  private readonly fetchFn: (input: string, init: RequestInit) => Promise<Response>;

  constructor(private readonly config: GrokClientConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.x.ai/v1').replace(/\/+$/, '');
    this.fetchFn = config.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /**
   * Runs a turn against the model with tools enabled and returns the parsed
   * result. Translates the Gemini-style turn list to OpenAI messages (assistant
   * tool_calls carry the ids, tool-role messages reference them). Retries on
   * 429/5xx/network errors; auth/bad-request errors fail fast.
   */
  async generate(opts: {
    contents: GeminiTurn[];
    systemInstruction: string;
    tools: GeminiFunctionDeclaration[];
  }): Promise<GeminiResult> {
    return withRetry(
      async () => {
        try {
          const payload = this.buildRequest(opts);
          const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify(payload),
          });
          return await this.parseResponse(res);
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  /**
   * Transcribes an audio/voice note. Chat models cannot hear raw audio, so this
   * uses the provider's OpenAI-compatible transcription route when available:
   * - HF Router (`router.huggingface.co`): multipart POST to `/audio/transcriptions`.
   * - xAI chat: best-effort `input_audio` content part (unsupported today, so
   *   this path usually fails and the transcriber asks the customer to repeat).
   */
  async transcribeAudio(opts: TranscribeAudioOptions): Promise<GeminiResult> {
    return withRetry(
      async () => {
        try {
          const res = await this.transcribeViaProvider(opts);
          return await this.parseResponse(res);
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  private isXai(): boolean {
    try {
      return new URL(this.baseUrl).hostname === 'api.x.ai';
    } catch {
      return false;
    }
  }

  private async transcribeViaProvider(opts: TranscribeAudioOptions): Promise<Response> {
    if (!this.isXai()) {
      // OpenAI-compatible transcription route (Groq whisper, HF Router STT):
      // multipart POST to `/audio/transcriptions` with the audio model name.
      const form = new FormData();
      form.append('file', new Blob([opts.buffer], { type: opts.mimeType }), `voice-note.${extForMime(opts.mimeType)}`);
      form.append('model', this.config.audioModel ?? this.config.model);
      const res = await this.fetchFn(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
      });
      if (res.ok) {
        const data = (await res.json()) as { text?: string };
        // Reuse the chat-completions response contract so parseResponse works:
        // wrap the transcription text as a plain chat reply.
        const wrapped = new Response(
          JSON.stringify({ choices: [{ message: { content: data.text ?? '' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
        return wrapped;
      }
      return res;
    }
    // xAI chat best-effort path (input_audio is not supported by Grok today).
    const content = [
      {
        type: 'text',
        text: opts.prompt ?? 'Transcribe this audio verbatim. Reply with only the transcription.',
      },
      {
        type: 'input_audio',
        input_audio: { data: opts.buffer.toString('base64'), format: mimeToAudioFormat(opts.mimeType) },
      },
    ];
    return this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ model: this.config.model, messages: [{ role: 'user', content }] }),
    });
  }

  /**
   * Sends an image with a prompt (vision) using the OpenAI image_url content
   * format, which vision-capable models (e.g. Qwen VL on the HF router)
   * accept. Used for product-photo → listing generation. Uses the optional
   * `visionModel` override so a text-only conversation model can stay primary.
   */
  async analyzeImage(opts: AnalyzeImageOptions): Promise<GeminiResult> {
    return withRetry(
      async () => {
        try {
          const content = [
            {
              type: 'text',
              text: opts.prompt ?? 'Describe this image.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${opts.mimeType};base64,${opts.buffer.toString('base64')}` },
            },
          ];
          const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.config.apiKey}`,
            },
            body: JSON.stringify({ model: this.config.visionModel ?? this.config.model, messages: [{ role: 'user', content }] }),
          });
          return await this.parseResponse(res);
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  /**
   * Translates the agent-facing turn list into OpenAI chat messages.
   * - systemInstruction → leading system message
   * - user/model text parts → user/assistant messages (same-role texts merged)
   * - model functionCall parts → assistant messages carrying tool_calls
   * - user functionResponse parts → tool-role messages referencing the call id
   */
  private buildRequest(opts: {
    contents: GeminiTurn[];
    systemInstruction: string;
    tools: GeminiFunctionDeclaration[];
  }): Record<string, unknown> {
    const messages: Array<GrokMessage | { role: 'assistant'; content: null; tool_calls: GrokToolCall[] }> = [];
    if (opts.systemInstruction) {
      messages.push({ role: 'system', content: opts.systemInstruction });
    }

    let seq = 0;
    const pendingCalls: Array<{ name: string; id: string }> = [];

    for (const turn of opts.contents) {
      for (const part of turn.parts) {
        if ('text' in part && part.text) {
          const role = turn.role === 'user' ? 'user' : 'assistant';
          const last = messages[messages.length - 1];
          if (last && last.role === role && 'content' in last && typeof last.content === 'string') {
            last.content += `\n${part.text}`;
          } else {
            messages.push({ role, content: part.text });
          }
        } else if ('functionCall' in part) {
          seq += 1;
          const id = `call_${seq}`;
          pendingCalls.push({ name: part.functionCall.name, id });
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              },
            ],
          });
        } else if ('functionResponse' in part) {
          const idx = pendingCalls.findIndex((c) => c.name === part.functionResponse.name);
          const toolCallId = idx >= 0 ? pendingCalls.splice(idx, 1)[0].id : `call_${(seq += 1)}`;
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify(part.functionResponse.response ?? {}),
          });
        }
      }
    }

    const payload: Record<string, unknown> = { model: this.config.model, messages };
    if (opts.tools.length > 0) {
      payload.tools = opts.tools.map(toOpenAiTool);
      payload.tool_choice = 'auto';
    }
    return payload;
  }

  private async parseResponse(res: Response): Promise<GeminiResult> {
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } | string };
        detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '');
      } catch {
        // Non-JSON error body — ignore.
      }
      // Deliberately NOT a GrokApiError: classifyError() derives retryability
      // from the status (429/5xx retry, everything else fails fast).
      throw Object.assign(new Error(detail || `HTTP ${res.status}`), { status: res.status });
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: GrokToolCall[] };
      }>;
    };
    const message = data.choices?.[0]?.message ?? {};
    const text = typeof message.content === 'string' ? message.content : '';
    const functionCalls = (message.tool_calls ?? [])
      .filter((tc) => tc.function && tc.function.name)
      .map((tc) => ({
        name: tc.function.name,
        args: safeParseJson(tc.function.arguments),
      }));
    return { text, functionCalls };
  }

  private get retryOptions() {
    return {
      attempts: this.config.retry?.attempts ?? 5,
      baseDelayMs: this.config.retry?.baseDelayMs ?? 1_000,
      maxDelayMs: this.config.retry?.maxDelayMs ?? 30_000,
      logger: this.config.logger,
      shouldRetry: (err: unknown) => (err instanceof GrokApiError ? err.retryable : true),
    };
  }

  private classifyError(err: unknown): GrokApiError {
    if (err instanceof GrokApiError) {
      this.config.onError?.(err);
      return err;
    }
    const like = err as { status?: number; message?: string; code?: string };
    let classified: GrokApiError;
    if (like.status === 429 || (like.status !== undefined && like.status >= 500)) {
      this.config.logger.warn('grok retryable error', { status: like.status, error: like.message });
      classified = new GrokApiError(like.message ?? 'Grok API error', like.status, true);
    } else if (like.status !== undefined) {
      this.config.logger.error('grok non-retryable error', { status: like.status, code: like.code, error: like.message });
      classified = new GrokApiError(like.message ?? 'Grok API error', like.status, false);
    } else {
      // Network-level failure (no response received) — transient, so retry.
      this.config.logger.warn('grok network error', { code: like.code, error: like.message });
      classified = new GrokApiError(like.message ?? 'Grok network error', undefined, true);
    }
    this.config.onError?.(classified);
    return classified;
  }
}

export class GrokApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'GrokApiError';
  }
}

function toOpenAiTool(decl: GeminiFunctionDeclaration): { type: 'function'; function: Record<string, unknown> } {
  const fn: Record<string, unknown> = { name: decl.name, parameters: normalizeJsonSchema(decl.parameters) };
  if (decl.description) fn.description = decl.description;
  return { type: 'function', function: fn };
}

/** Gemini types are upper-case (OBJECT/STRING/…); OpenAI-compatible providers
 * require valid JSON Schema (object/string/…), so normalize recursively. */
function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && typeof value === 'string') {
      out.type = value.toLowerCase();
    } else if (key === 'items' && value && typeof value === 'object' && !Array.isArray(value)) {
      out.items = normalizeJsonSchema(value as Record<string, unknown>);
    } else if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(value as Record<string, unknown>)) {
        props[name] = p && typeof p === 'object' && !Array.isArray(p)
          ? normalizeJsonSchema(p as Record<string, unknown>)
          : p;
      }
      out.properties = props;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mimeToAudioFormat(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.toLowerCase() ?? '';
  return ext === 'ogg' ? 'ogg' : ext === 'amr' ? 'amr' : ext === 'mp3' || ext === 'mpeg' ? 'mp3' : 'wav';
}

/** Maps a mimeType to the file extension used in the transcription upload. */
function extForMime(mimeType: string): string {
  const ext = mimeType.split('/')[1]?.toLowerCase() ?? '';
  if (ext === 'x-m4a') return 'm4a';
  if (ext === 'mpeg' || ext === 'mpga') return 'mp3';
  if (ext === 'quicktime') return 'mp4';
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'bin';
}

export function grokErrorMessage(err: unknown): string {
  return messageFromError(err);
}
