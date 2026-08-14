import type { GeminiLike, GeminiResult } from './types';
import { geminiErrorMessage } from './client';

/**
 * Detected language of a transcribed voice note. `other` means the
 * transcriber flagged something outside ha/pcm/en; `unknown` means no signal.
 */
export type DetectedLanguage = 'ha' | 'pcm' | 'en' | 'other' | 'unknown';

export interface TranscriptionResult {
  /** Verbatim transcript. Empty string when the audio was inaudible/silent. */
  text: string;
  language: DetectedLanguage;
  /** 0..1 — how confident the transcriber is in text + language. */
  confidence: number;
  /** True when the audio was clear enough to act on (text non-empty + confidence high). */
  clear: boolean;
}

export interface TranscriptionConfig {
  /** Minimum confidence (0..1) below which a transcript is treated as unclear. */
  minConfidence?: number;
}

/**
 * The seam every transcription provider plugs into. The production
 * implementation is Gemini (reuses the existing GEMINI_API_KEY); tests inject
 * a fake that never hits the network.
 */
export interface Transcriber {
  transcribe(input: { buffer: Buffer; mimeType: string }): Promise<TranscriptionResult>;
}

/** Narrow view of the LLM the transcriber needs — keeps it decoupled. */
export interface TranscriptionLlm {
  transcribeAudio(opts: { buffer: Buffer; mimeType: string; prompt?: string }): Promise<GeminiResult>;
}

const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Gemini-based transcriber. Sends the raw audio bytes to the model (native
 * audio understanding — no separate STT vendor), parses the strict-JSON
 * response, and applies the confidence gate. A malformed / non-JSON reply is
 * surfaced as an unclear result, never a crash — the customer gets asked to
 * repeat instead of being left with nothing.
 */
export class GeminiTranscriber implements Transcriber {
  constructor(
    private readonly llm: TranscriptionLlm,
    private readonly config: TranscriptionConfig = {},
  ) {}

  async transcribe(input: { buffer: Buffer; mimeType: string }): Promise<TranscriptionResult> {
    const minConfidence = this.config.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    let raw: string;
    try {
      const result = await this.llm.transcribeAudio({ ...input });
      raw = result.text ?? '';
    } catch {
      // Network/transient failures are retried by the client; reaching here
      // means the note could not be understood — treat as unclear.
      return { text: '', language: 'unknown', confidence: 0, clear: false };
    }

    const parsed = parseTranscriptionJson(raw);
    const text = (parsed?.text ?? '').trim();
    const confidence = clamp01(Number(parsed?.confidence) || 0);
    const language = normalizeLanguage(parsed?.language, text);
    const clear = text.length > 0 && confidence >= minConfidence;
    return { text, language, confidence, clear };
  }
}

/** Parses the model's JSON blob, tolerating code fences and leading prose. */
export function parseTranscriptionJson(raw: string): { text?: string; language?: string; confidence?: number } | null {
  const stripped = raw
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as { text?: string; language?: string; confidence?: number };
  } catch {
    return null;
  }
}

/**
 * Normalises a transcriber language label to our DetectedLanguage, and falls
 * back to a lightweight keyword heuristic when the label is missing/'other'.
 * Heuristic only ever upgrades *towards* ha/pcm/en — never guesses away from
 * a confident provider label.
 */
export function normalizeLanguage(label: string | undefined, text: string): DetectedLanguage {
  const l = (label ?? '').trim().toLowerCase();
  if (l === 'ha' || l === 'hausa') return 'ha';
  if (l === 'pcm' || l === 'pidgin' || l === 'nigerian pidgin') return 'pcm';
  if (l === 'en' || l === 'english') return 'en';
  if (l === 'other') {
    const detected = detectLanguage(text);
    return detected === 'unknown' ? 'other' : detected;
  }
  return detectLanguage(text);
}

const HAUSA_MARKERS = [
  'ina kwana', 'sannu', 'yaya', 'na gode', 'gaskiya', 'barka', 'zaka', 'zaki', 'ina son', 'da kyau',
  'akwai', 'nawa', 'farashin', 'kudin', 'sai', 'dama', 'wace', 'wane', 'muna', 'ina bukatar',
  'ba ni', 'kayan', 'sayo', 'na saya', 'yau', 'gobe', 'wajen', 'sha biyu', 'ashirin', 'kuma',
];

const PIDGIN_MARKERS = [
  'how far', 'na so', 'i dey', 'you dey', 'e dey', 'dey go', 'no be', 'abeg', 'wetin', 'wetin',
  'make i', 'make we', 'dem dey', 'una', 'i wan', 'i want', 'dey', 'ooh', 'e don', 'i don',
  'small small', 'bro', 'my guy', 'oya', 'chop', 'money', 'price', 'how much', 'which one',
  'i get', 'e get', 'no wahala', 'go ahead', 'sharp', 'level', 'correct', 'i no know', 'e no',
];

const ENGLISH_MARKERS = [
  'the', 'and', 'you', 'your', 'please', 'want', 'need', 'have', 'how much', 'price', 'order',
  'product', 'stock', 'delivery', 'available', 'total', 'confirm', 'bag', 'kilo', 'rice', 'oil',
];

function scoreFor(markers: string[], text: string): number {
  const lower = ` ${text.toLowerCase()} `;
  let score = 0;
  for (const m of markers) {
    if (lower.includes(` ${m} `) || lower.startsWith(`${m} `) || lower.endsWith(` ${m}`) || lower.includes(m)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Keyword heuristic for Hausa vs Pidgin vs English. Returns the highest
 * scoring language, or `unknown` when nothing matched. Used only when the
 * provider gives no usable label — never as a substitute for real detection.
 */
export function detectLanguage(text: string): 'ha' | 'pcm' | 'en' | 'unknown' {
  const ha = scoreFor(HAUSA_MARKERS, text);
  const pcm = scoreFor(PIDGIN_MARKERS, text);
  const en = scoreFor(ENGLISH_MARKERS, text);
  if (ha >= pcm && ha >= en && ha > 0) return 'ha';
  if (pcm >= ha && pcm >= en && pcm > 0) return 'pcm';
  if (en > 0) return 'en';
  return 'unknown';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Human-readable label for the reply language (used in ask-to-repeat messages). */
export function languageName(lang: DetectedLanguage): string {
  switch (lang) {
    case 'ha':
      return 'Hausa';
    case 'pcm':
      return 'Nigerian Pidgin';
    case 'en':
      return 'English';
    case 'other':
      return 'a language we did not recognise';
    default:
      return 'an unclear language';
  }
}

export function transcriptionErrorMessage(err: unknown): string {
  return geminiErrorMessage(err);
}