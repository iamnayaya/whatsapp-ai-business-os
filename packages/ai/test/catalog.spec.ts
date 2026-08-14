import { describe, expect, it, vi } from 'vitest';
import { CatalogGenerator, parseCatalogJson, buildCatalogPrompt } from '../src/catalog';
import type { VisionLlm, CatalogGenerationResult } from '../src/catalog';

function makeLlm(text: string): VisionLlm {
  return { analyzeImage: vi.fn(async () => ({ text, functionCalls: [] })) };
}

const CONFIG = { businessName: 'Ahmad Nayaya', currency: 'NGN' };

function gen(llm: VisionLlm, minPrice = 0): CatalogGenerator {
  return new CatalogGenerator(llm, CONFIG, minPrice);
}

describe('parseCatalogJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseCatalogJson('{"usable":true,"title":"Rice","tags":["rice"]}')).toEqual({
      usable: true,
      title: 'Rice',
      tags: ['rice'],
    });
  });

  it('tolerates markdown code fences', () => {
    const raw = '```json\n{"usable":false,"reason":"blurry"}\n```';
    expect(parseCatalogJson(raw)).toEqual({ usable: false, reason: 'blurry' });
  });

  it('returns null for non-JSON output', () => {
    expect(parseCatalogJson('I could not understand this photo.')).toBeNull();
  });
});

describe('buildCatalogPrompt', () => {
  it('includes the business name and currency and the honesty rules', () => {
    const prompt = buildCatalogPrompt(CONFIG);
    expect(prompt).toContain('Ahmad Nayaya');
    expect(prompt).toContain('NGN');
    expect(prompt).toContain('NEVER invent');
    expect(prompt).toContain('usable": false');
  });
});

describe('CatalogGenerator', () => {
  const info = { price: 50000, quantity: 10, category: undefined };

  it('returns a clean listing for a good photo', async () => {
    const llm = makeLlm(
      '{"usable":true,"title":"50kg Rice Bag","description":"A large 50kg bag of white rice.","tags":["rice","grocery","staple"],"category":"Groceries"}',
    );
    const result = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info });
    expect(result.usable).toBe(true);
    expect(result.listing).toEqual({
      title: '50kg Rice Bag',
      description: 'A large 50kg bag of white rice.',
      tags: ['rice', 'grocery', 'staple'],
      category: 'Groceries',
    });
  });

  it('rejects a blurry / unusable photo and never hallucinates a listing', async () => {
    const llm = makeLlm('{"usable":false,"reason":"Image is too blurry to identify the product."}');
    const result: CatalogGenerationResult = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info });
    expect(result.usable).toBe(false);
    expect(result.listing).toBeUndefined();
    expect(result.reason).toContain('blurry');
  });

  it('rejects a malformed / non-JSON model response', async () => {
    const llm = makeLlm('I cannot process this image, please retake the photo.');
    const result = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info });
    expect(result.usable).toBe(false);
    expect(result.listing).toBeUndefined();
  });

  it('rejects a listing missing a title or description', async () => {
    const llm = makeLlm('{"usable":true,"title":"","description":"","tags":[]}');
    const result = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info });
    expect(result.usable).toBe(false);
  });

  it('honours an explicit category override from the owner', async () => {
    const llm = makeLlm('{"usable":true,"title":"Soap Bar","description":"A bar of white soap.","tags":["soap"],"category":"Other"}');
    const result = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info: { ...info, category: 'Personal Care' } });
    expect(result.listing?.category).toBe('Personal Care');
  });

  it('guards against nonsense prices and quantities', async () => {
    const llm = makeLlm('{"usable":true,"title":"X","description":"Y","tags":[]}');
    expect((await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info: { price: -5, quantity: 3 } })).usable).toBe(false);
    expect((await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info: { price: 100, quantity: -1 } })).usable).toBe(false);
    expect((await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info: { price: 100, quantity: 2.5 } })).usable).toBe(false);
  });

  it('treats a thrown vision error as an unusable result (never crashes)', async () => {
    const llm: VisionLlm = { analyzeImage: vi.fn(async () => { throw new Error('network down'); }) };
    const result = await gen(llm).generate({ buffer: Buffer.from('x'), mimeType: 'image/jpeg', info });
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('could not process');
  });
});