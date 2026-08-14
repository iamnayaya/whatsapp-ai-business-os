import type { GeminiResult } from './types';
import { geminiErrorMessage } from './client';

/**
 * The seam the catalog generator depends on. Production uses GeminiClient
 * (`analyzeImage`); tests inject a fake that never touches the network.
 */
export interface VisionLlm {
  analyzeImage(opts: { buffer: Buffer; mimeType: string; prompt?: string }): Promise<GeminiResult>;
}

export interface CatalogBasicInfo {
  /** Price in the business currency (NGN). */
  price: number;
  /** Initial stock quantity. */
  quantity: number;
  /** Optional category override — when omitted the model suggests one. */
  category?: string;
  /** Optional SKU override — when omitted the service generates one. */
  sku?: string;
}

export interface GeneratedListing {
  title: string;
  description: string;
  tags: string[];
  category: string;
}

export interface CatalogGenerationResult {
  /** False when the image is unusable — caller must ask for a better photo. */
  usable: boolean;
  /** Why the image was rejected (only set when usable=false). */
  reason?: string;
  listing?: GeneratedListing;
}

export interface CatalogGenerationConfig {
  businessName: string;
  currency: string;
}

/**
 * Strict-JSON prompt. Two hard rules keep the listing honest:
 * 1. Only describe what is actually visible in the photo — never invent
 *    brands, weights, capacities, or features that cannot be seen.
 * 2. If the photo is blurry / dark / unclear / contains no recognisable
 *    product, report usable:false instead of hallucinating a listing.
 */
export function buildCatalogPrompt({ businessName, currency }: CatalogGenerationConfig): string {
  return [
    `You are the catalog writer for ${businessName}, a friendly WhatsApp-based shop selling in ${currency}.`,
    `A customer/owner uploaded a product photo. Turn it into a clean, attractive listing.`,
    ``,
    `Respond with ONLY valid JSON, no commentary, in this exact shape:`,
    `{"usable": true, "title": "<clean product title>", "description": "<2-3 sentence description>", "tags": ["<tag1>", "<tag2>", "<tag3>"], "category": "<category>"}`,
    ``,
    `RULES — follow exactly:`,
    `1. ONLY describe what is VISIBLE in the photo. NEVER invent brand names, weights, sizes, capacities, material, or quantities that you cannot actually see.`,
    `2. If the image is blurry, out of focus, too dark, has no clear product, is mostly text/logo with no item, or you cannot confidently identify the product — respond with {"usable": false, "reason": "<short reason>"} instead. Never guess.`,
    `3. Title: short (max ~8 words), descriptive, searchable (what the product is).`,
    `4. Description: 2-3 sentences, warm and friendly, mention only what is visible, keep it salesy but honest. No delivery/payment promises.`,
    `5. Tags: 3-6 short lowercase tags (e.g. ["rice", "grocery", "50kg"]).`,
    `6. Category: pick a sensible category from the business's domain (e.g. Groceries, Home & Cleaning, Personal Care, Beverages, Snacks, Appliances, Other).`,
  ].join('\n');
}

const DEFAULT_MIN_PRICE = 0;

/**
 * Generates a product listing from a photo + basic info using a vision model.
 * Parses the model's strict-JSON reply and enforces the usable gate. A
 * malformed response is treated as "ask for a better photo" — never saved.
 */
export class CatalogGenerator {
  constructor(
    private readonly llm: VisionLlm,
    private readonly config: CatalogGenerationConfig,
    private readonly minPrice: number = DEFAULT_MIN_PRICE,
  ) {}

  async generate(input: { buffer: Buffer; mimeType: string; info: CatalogBasicInfo }): Promise<CatalogGenerationResult> {
    // Basic sanity guard: a nonsense price shouldn't be published either.
    if (!Number.isFinite(input.info.price) || input.info.price < this.minPrice) {
      return { usable: false, reason: `Price must be at least ${this.minPrice}` };
    }
    if (!Number.isInteger(input.info.quantity) || input.info.quantity < 0) {
      return { usable: false, reason: 'Quantity must be a non-negative whole number' };
    }

    let raw: string;
    try {
      const result = await this.llm.analyzeImage({
        buffer: input.buffer,
        mimeType: input.mimeType,
        prompt: buildCatalogPrompt(this.config),
      });
      raw = result.text ?? '';
    } catch {
      return { usable: false, reason: 'The vision model could not process this image — please try again or use a clearer photo.' };
    }

    const parsed = parseCatalogJson(raw);
    if (!parsed) {
      return { usable: false, reason: 'The vision model gave an unreadable response — please retry with a clearer photo.' };
    }
    if (parsed.usable === false) {
      return { usable: false, reason: parsed.reason ?? 'This photo is not clear enough to list.' };
    }

    const title = (parsed.title ?? '').trim();
    const description = (parsed.description ?? '').trim();
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter(Boolean) : [];
    const category = (input.info.category ?? parsed.category ?? '').trim();

    if (!title || !description) {
      return { usable: false, reason: 'The listing was missing a title or description — please retry with a clearer photo.' };
    }

    return {
      usable: true,
      listing: { title, description, tags, category },
    };
  }
}

interface RawCatalogJson {
  usable?: boolean;
  reason?: string;
  title?: string;
  description?: string;
  tags?: unknown;
  category?: string;
}

/** Parses the model's JSON, tolerating code fences and leading prose. */
export function parseCatalogJson(raw: string): RawCatalogJson | null {
  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1)) as RawCatalogJson;
  } catch {
    return null;
  }
}

export function catalogErrorMessage(err: unknown): string {
  return geminiErrorMessage(err);
}