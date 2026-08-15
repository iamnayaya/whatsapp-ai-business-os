import type { AppLogger } from '../../shared/src/logger';
import { GeminiClient } from './client';
import type { GeminiResult, GeminiTurn, TranscribeAudioOptions, AnalyzeImageOptions } from './client';
import { GrokClient } from './grok';

export interface LlmClientConfig {
  /** Primary OpenAI-compatible provider key (Groq, xAI, HF Router, …). */
  groqApiKey?: string;
  groqModel?: string;
  groqBaseUrl?: string;
  /** Optional separate vision model on the same provider. */
  groqVisionModel?: string;
  /** Audio transcription model (whisper) used for voice notes. */
  groqAudioModel?: string;
  /** Optional separate vision provider (Groq has no vision today; the HF
   * Router's Qwen VL is used for product-photo → listing generation). */
  visionApiKey?: string;
  visionBaseUrl?: string;
  visionModel?: string;
  /** Gemini key — fallback provider used when no Groq key is set. */
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
 * - GROQ_API_KEY set  → Groq drives conversations (generate), vision
 *   (analyzeImage) and voice transcription (whisper). A separate vision
 *   provider can be configured via VISION_* (Groq has no vision models).
 * - No Groq key → Gemini backs everything (previous behaviour).
 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const shared = { logger: config.logger, onError: config.onError };

  if (!config.groqApiKey) {
    if (!config.geminiApiKey) {
      throw new Error('No LLM provider configured: set GROQ_API_KEY or GEMINI_API_KEY');
    }
    return new GeminiClient({
      apiKey: config.geminiApiKey,
      model: config.geminiModel ?? 'gemini-flash-latest',
      ...shared,
    });
  }

  const grok = new GrokClient({
    apiKey: config.groqApiKey,
    model: config.groqModel ?? 'openai/gpt-oss-120b',
    baseUrl: config.groqBaseUrl ?? 'https://api.groq.com/openai/v1',
    visionModel: config.groqVisionModel,
    audioModel: config.groqAudioModel,
    fetchFn: config.fetchFn,
    ...shared,
  });

  if (!config.visionApiKey) {
    return grok;
  }

  const vision = new GrokClient({
    apiKey: config.visionApiKey,
    model: config.visionModel ?? config.groqModel ?? 'openai/gpt-oss-120b',
    baseUrl: config.visionBaseUrl ?? config.groqBaseUrl ?? 'https://api.groq.com/openai/v1',
    fetchFn: config.fetchFn,
    ...shared,
  });

  // Conversations + voice via Groq, product-photo vision via the VLM provider.
  return {
    generate: (opts) => grok.generate(opts),
    transcribeAudio: (opts) => grok.transcribeAudio(opts),
    analyzeImage: (opts) => vision.analyzeImage(opts),
  };
}
