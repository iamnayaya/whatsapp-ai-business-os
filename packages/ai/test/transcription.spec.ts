import { describe, expect, it, vi } from 'vitest';
import { GeminiTranscriber, parseTranscriptionJson, normalizeLanguage, detectLanguage, languageName } from '../src/transcription';
import type { TranscriptionLlm } from '../src/transcription';

function makeLlm(text: string): TranscriptionLlm {
  return { transcribeAudio: vi.fn(async () => ({ text, functionCalls: [] })) };
}

describe('parseTranscriptionJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseTranscriptionJson('{"text":"ina son rice","language":"ha","confidence":0.9}')).toEqual({
      text: 'ina son rice',
      language: 'ha',
      confidence: 0.9,
    });
  });

  it('tolerates markdown code fences', () => {
    const raw = '```json\n{"text":"na dey good","language":"pcm","confidence":0.85}\n```';
    expect(parseTranscriptionJson(raw)).toEqual({ text: 'na dey good', language: 'pcm', confidence: 0.85 });
  });

  it('tolerates leading prose before the JSON object', () => {
    expect(parseTranscriptionJson('Here you go: {"text":"hello","language":"en","confidence":1}')).toEqual({
      text: 'hello',
      language: 'en',
      confidence: 1,
    });
  });

  it('returns null for non-JSON output', () => {
    expect(parseTranscriptionJson('I could not understand the audio.')).toBeNull();
  });
});

describe('GeminiTranscriber', () => {
  it('returns a clear result for high-confidence Hausa text', async () => {
    const transcriber = new GeminiTranscriber(makeLlm('{"text":"ina bukatar rice 50kg","language":"ha","confidence":0.91}'));
    const result = await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect(result).toEqual({ text: 'ina bukatar rice 50kg', language: 'ha', confidence: 0.91, clear: true });
  });

  it('marks unclear when confidence is below the gate', async () => {
    const transcriber = new GeminiTranscriber(makeLlm('{"text":"something garbled","language":"en","confidence":0.2}'));
    const result = await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect(result.clear).toBe(false);
    expect(result.text).toBe('something garbled');
    expect(result.language).toBe('en');
  });

  it('marks unclear for an empty / silent transcript', async () => {
    const transcriber = new GeminiTranscriber(makeLlm('{"text":"","language":"ha","confidence":0.1}'));
    const result = await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect(result.clear).toBe(false);
    expect(result.text).toBe('');
  });

  it('respects a custom minConfidence threshold', async () => {
    const transcriber = new GeminiTranscriber(makeLlm('{"text":"dey go","language":"pcm","confidence":0.4}'), { minConfidence: 0.3 });
    expect((await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' })).clear).toBe(true);
  });

  it('falls back to language detection when the model says other', async () => {
    const transcriber = new GeminiTranscriber(makeLlm('{"text":"yaya dai, ina kwana","language":"other","confidence":0.8}'));
    const result = await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect(result.language).toBe('ha');
    expect(result.clear).toBe(true);
  });

  it('surfaces an unclear result when the LLM throws (never crashes the pipeline)', async () => {
    const llm = { transcribeAudio: vi.fn(async () => { throw new Error('boom'); }) };
    const transcriber = new GeminiTranscriber(llm);
    const result = await transcriber.transcribe({ buffer: Buffer.from('x'), mimeType: 'audio/ogg' });
    expect(result).toEqual({ text: '', language: 'unknown', confidence: 0, clear: false });
  });
});

describe('detectLanguage', () => {
  it('detects Hausa', () => {
    expect(detectLanguage('ina bukatar rice 50kg, nawa kudin?')).toBe('ha');
    expect(detectLanguage('barka dai, na gode')).toBe('ha');
  });

  it('detects Nigerian Pidgin', () => {
    expect(detectLanguage('abeg how far, i dey want buy rice')).toBe('pcm');
    expect(detectLanguage('na so, e dey go, no wahala')).toBe('pcm');
  });

  it('detects English', () => {
    expect(detectLanguage('please I want to order some rice')).toBe('en');
    expect(detectLanguage('the product stock and delivery')).toBe('en');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectLanguage('zzzz qqqq')).toBe('unknown');
  });
});

describe('normalizeLanguage', () => {
  it('passes through known provider labels', () => {
    expect(normalizeLanguage('ha', 'anything')).toBe('ha');
    expect(normalizeLanguage('pcm', 'anything')).toBe('pcm');
    expect(normalizeLanguage('en', 'anything')).toBe('en');
    expect(normalizeLanguage('hausa', 'anything')).toBe('ha');
    expect(normalizeLanguage('nigerian pidgin', 'anything')).toBe('pcm');
  });

  it('detects from text when the label is missing or other', () => {
    expect(normalizeLanguage('other', 'ina kwana yaya')).toBe('ha');
    expect(normalizeLanguage(undefined, 'abeg i dey')).toBe('pcm');
    expect(normalizeLanguage('other', 'please help me')).toBe('en');
    expect(normalizeLanguage('other', 'zzzz')).toBe('other');
  });
});

describe('languageName', () => {
  it('maps codes to human labels', () => {
    expect(languageName('ha')).toBe('Hausa');
    expect(languageName('pcm')).toBe('Nigerian Pidgin');
    expect(languageName('en')).toBe('English');
    expect(languageName('unknown')).toBe('an unclear language');
  });
});