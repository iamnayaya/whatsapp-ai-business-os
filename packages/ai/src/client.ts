import { GoogleGenerativeAI, FunctionCallingMode, type FunctionDeclaration, type GenerativeModel, type Tool } from '@google/generative-ai';
import type { AppLogger } from '../../shared/src/logger';
import { messageFromError } from '../../shared/src/errors';
import { withRetry } from '../../shared/src/retry';

export interface GeminiClientConfig {
  apiKey: string;
  model: string;
  logger: AppLogger;
  /**
   * Optional hook fired once per FAILED generation call (before retry/backoff
   * decisions). Used by the monitoring package to detect AI error spikes.
   */
  onError?: (err: unknown) => void;
}

export interface GeminiTurn {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

/**
 * The shape the agent layer uses. Kept independent of the SDK's `Schema` type
 * (which is an enum-typed union) so the agent + tools stay decoupled; the cast
 * to `FunctionDeclaration` happens only at the SDK boundary.
 */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters: { type: 'OBJECT'; properties: Record<string, unknown>; required?: string[] };
}

export interface GeminiResult {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface TranscribeAudioOptions {
  buffer: Buffer;
  mimeType: string;
  prompt?: string;
}

export interface AnalyzeImageOptions {
  buffer: Buffer;
  mimeType: string;
  prompt?: string;
}

/** Instructs the model to return a strict JSON object we parse afterwards. */
export const DEFAULT_TRANSCRIBE_PROMPT = [
  `Transcribe the speech in this voice note VERBATIM, in the exact language it was spoken.`,
  `Respond with ONLY valid JSON, no commentary, in this exact shape:`,
  `{"text": "<full verbatim transcript>", "language": "<ha|pcm|en|other>", "confidence": <0.0 to 1.0>}`,
  ``,
  `Rules:`,
  `- Do NOT translate, paraphrase, spell-correct, or "clean up" the speaker's words.`,
  `- "language": ha for Hausa, pcm for Nigerian Pidgin, en for English, other if it is something else.`,
  `- "confidence": how certain you are the transcript is accurate and complete (1.0 = certain).`,
  `- If the audio is silent, too short, mostly noise, or the speech is inaudible, return "text": "" with a confidence below 0.3.`,
  `- Keep numbers, prices, and product names exactly as spoken.`,
].join('\n');

/**
 * Thin, dependency-injectable wrapper around the Gemini SDK so the agent loop
 * (and its tests) never talk to a live model. `generate` is the only method
 * the rest of the code needs.
 */
export class GeminiClient {
  private readonly model: GenerativeModel;

  constructor(private readonly config: GeminiClientConfig) {
    const genAi = new GoogleGenerativeAI(config.apiKey);
    this.model = genAi.getGenerativeModel({ model: config.model });
  }

  /**
   * Runs a turn against the model with tools enabled and returns the parsed
   * result. Retries on 429/5xx/network errors (via the shared retry helper);
   * the model name itself fails fast.
   */
  async generate(opts: {
    contents: GeminiTurn[];
    systemInstruction: string;
    tools: GeminiFunctionDeclaration[];
  }): Promise<GeminiResult> {
    const { contents, systemInstruction, tools } = opts;
    const tool: Tool = { functionDeclarations: tools as unknown as FunctionDeclaration[] };
    return withRetry(
      async () => {
        try {
          const result = await this.model.generateContent({
            systemInstruction,
            contents: contents as never,
            tools: [tool],
            toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
          });
          const response = result.response;
          let text = '';
          try {
            text = response.text();
          } catch {
            // No text part (e.g. the response is a function call only).
          }
          const calls = response.functionCalls() ?? [];
          const functionCalls = calls.map((c) => ({
            name: c.name,
            args: (c.args as Record<string, unknown>) ?? {},
          }));
          return { text, functionCalls };
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  /**
   * Transcribes an audio/voice note in place. Uses Gemini's native audio
   * understanding (no separate STT vendor needed) and asks the model to
   * return a strict JSON blob: { text, language, confidence }.
   */
  async transcribeAudio(opts: TranscribeAudioOptions): Promise<GeminiResult> {
    const { buffer, mimeType } = opts;
    const prompt = opts.prompt ?? DEFAULT_TRANSCRIBE_PROMPT;
    return withRetry(
      async () => {
        try {
          const result = await this.model.generateContent({
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType, data: buffer.toString('base64') } },
                  { text: prompt },
                ],
              },
            ] as never,
          });
          return { text: result.response.text(), functionCalls: [] };
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  /**
   * Sends an image with a prompt (vision). Used for product-photo → listing
   * generation (Phase 4). Uses the same retry policy as the other calls.
   */
  async analyzeImage(opts: AnalyzeImageOptions): Promise<GeminiResult> {
    const { buffer, mimeType } = opts;
    const prompt = opts.prompt ?? 'Describe this image.';
    return withRetry(
      async () => {
        try {
          const result = await this.model.generateContent({
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType, data: buffer.toString('base64') } },
                  { text: prompt },
                ],
              },
            ] as never,
          });
          return { text: result.response.text(), functionCalls: [] };
        } catch (err) {
          throw this.classifyError(err);
        }
      },
      this.retryOptions,
    );
  }

  private get retryOptions() {
    return {
      attempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      logger: this.config.logger,
      shouldRetry: (err: unknown) => (err instanceof GeminiApiError ? err.retryable : true),
    };
  }

  private classifyError(err: unknown): GeminiApiError {
    if (err instanceof GeminiApiError) {
      this.config.onError?.(err);
      return err;
    }
    const like = err as { status?: number; message?: string; code?: string };
    // 429 and 5xx retry; other HTTP errors (400, 403, auth) fail fast.
    let classified: GeminiApiError;
    if (like.status === 429 || (like.status !== undefined && like.status >= 500)) {
      this.config.logger.warn('gemini retryable error', { status: like.status, error: like.message });
      classified = new GeminiApiError(like.message ?? 'Gemini API error', like.status, true);
    } else if (like.status !== undefined) {
      this.config.logger.error('gemini non-retryable error', { status: like.status, code: like.code, error: like.message });
      classified = new GeminiApiError(like.message ?? 'Gemini API error', like.status, false);
    } else {
      // Network-level failure (no response received) — transient, so retry.
      this.config.logger.warn('gemini network error', { code: like.code, error: like.message });
      classified = new GeminiApiError(like.message ?? 'Gemini network error', undefined, true);
    }
    this.config.onError?.(classified);
    return classified;
  }
}

export class GeminiApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

export function isGeminiError(err: unknown): err is GeminiApiError {
  return err instanceof GeminiApiError;
}

export function geminiErrorMessage(err: unknown): string {
  return messageFromError(err);
}