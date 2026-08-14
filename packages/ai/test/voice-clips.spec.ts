import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../../shared/src';
import { GeminiClient, GeminiTranscriber } from '../src';

/**
 * Real-audio smoke tests for Phase 3. These run against the live Gemini API
 * using the sample clips the owner drops into test/fixtures/audio/.
 *
 * They are skipped (not failed) when either the fixtures or GEMINI_API_KEY are
 * missing, so CI/offline runs stay green. To run: place the 3 clips, set
 * GEMINI_API_KEY, then `npx vitest run packages/ai/test/voice-clips.spec.ts`.
 */

interface ClipExpectation {
  file: string;
  /** Expected detected language for this clip. */
  language: 'ha' | 'pcm' | 'en';
  /** Any Hausa/Pidgin marker the transcript should contain (case-insensitive). */
  marker?: string;
}

const EXPECTED: ClipExpectation[] = [
  { file: 'hausa.ogg', language: 'ha', marker: 'rice' },
  { file: 'pidgin.ogg', language: 'pcm', marker: 'rice' },
  { file: 'mixed.ogg', language: 'en', marker: 'rice' },
];

function findFixtureFiles(): string[] {
  try {
    return readdirSync(join(__dirname, 'fixtures', 'audio')).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
}

const available = findFixtureFiles();
const apiKey = process.env.GEMINI_API_KEY;
const canRun = available.length > 0 && Boolean(apiKey);

const logger = createLogger('voice-clips', { destination: () => undefined });

describe.skipIf(!canRun)('real voice note transcription (Phase 3)', () => {
  const transcriber = new GeminiTranscriber(
    new GeminiClient({ apiKey: apiKey!, model: process.env.GEMINI_MODEL ?? 'gemini-flash-latest', logger }),
  );

  for (const expectation of EXPECTED) {
    const clipPath = join(__dirname, 'fixtures', 'audio', expectation.file);
    const exists = available.includes(expectation.file);

    it.skipIf(!exists)(`transcribes ${expectation.file} as ${expectation.language}`, async () => {
      const buffer = readFileSync(clipPath);
      const mimeType = mimeFor(expectation.file);
      const result = await transcriber.transcribe({ buffer, mimeType });

      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.language).toBe(expectation.language);
      if (expectation.marker) {
        expect(result.text.toLowerCase()).toContain(expectation.marker);
      }
      expect(result.clear).toBe(true);
    });
  }
});

function mimeFor(file: string): string {
  if (file.endsWith('.ogg')) return 'audio/ogg';
  if (file.endsWith('.mp3')) return 'audio/mpeg';
  if (file.endsWith('.m4a')) return 'audio/mp4';
  if (file.endsWith('.aac')) return 'audio/aac';
  if (file.endsWith('.wav')) return 'audio/wav';
  return 'audio/ogg';
}