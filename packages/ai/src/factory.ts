import type { AppLogger } from '../../shared/src/logger';
import { GeminiClient } from './client';
import type { GeminiResult, GeminiTurn, TranscribeAudioOptions, AnalyzeImageOptions } from './client';
import { GrokClient } from './grok';

export interface LlmClientConfig {
  /** Grok (xAI) key — when set, the conversation agent uses Grok. */
  xaiApiKey?: string;
  xaiModel?: string;
  xaiBaseUrl?: string;
  /** Gemini key — the fallback provider and the voice-note transcriber. */
  geminiApiKey?: string;
  geminiModel?: string;
  logger: AppLogger;
  /** Hook fired on each failed provider call (monitoring / AI error spikes). */
  onError?: (err: unknown) => void;
  /** Injectable transport (tests). */
  fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * The union of provider methods the app consumes. All three are optional-only
 * in shape (transcription is optional at runtime), so any provider can back
 * them.
 */
export interface LlmClient {
  generate(opts: {
    contents: GeminiTurn[];
    systemInstruction: string;
    tools: Array<{ name: string; description?: string; parameters: { type: 'OBJECT'; properties: Record<string, unknown>; required?: string[] } }>;
  }): Promise<GeminiResult>;
  transcribeAudio(opts: TranscribeAudioOptions): Promise<GeminiResult>;
  analyzeImage(opts: AnalyzeImageOptions): Promise<GeminiResult>;
}

/**
 * Builds the LLM client from env. Rules:
 * - XAI_API_KEY set  → Grok drives conversations (generate) AND vision
 *   (analyzeImage, which grok-4.x supports natively).
 * - Voice-note transcription keeps using Gemini when GEMINI_API_KEY is also
 *   present (Grok's chat endpoint does not accept raw audio today).
 * - No XAI key → Gemini backs everything (previous behaviour).
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const shared = { logger: config.logger, onError: config.onError };

  if (!config.xaiApiKey) {
    if (!config.geminiApiKey) {
      throw new Error('No LLM provider configured: set XAI_API_KEY or GEMINI_API_KEY');
    }
    return new GeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel ?? 'gemini-flash-latest',
      ...shared,
    });
  }

  const grok = new GrokClient({
    apiKey: config.xaiApiKey,
    model: config.xaiModel ?? 'grok-4.6',
    baseUrl: config.xaiBaseUrl,
    fetchFn: config.fetchFn,
    ...shared,
  });

  if (!config.geminiApiKey) {
    return grok;
  }

  const gemini = new GeminiClient({
    apiKey: config.geminiApiKey,
    model: config.geminiModel ?? 'gemini-flash-latest',
    ...shared,
  });

  // Hybrid: conversations + vision via Grok, voice notes via Gemini.
  return {
    generate: (opts) => grok.generate(opts),
    transcribeAudio: (opts) => gemini.transcribeAudio(opts),
    analyzeImage: (opts) => grok.analyzeImage(opts),
  };
}
