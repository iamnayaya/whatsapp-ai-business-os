import { Injectable, Inject } from '@nestjs/common';
import type {} from 'multer';
import type { PrismaClient } from '../../../../packages/db/src';
import type { AppLogger } from '../../../../packages/shared/src';
import type { GeneratedListing } from '../../../../packages/ai/src';
import { CatalogGenerator, createLlmClient } from '../../../../packages/ai/src';
import {
  CatalogService,
  type CatalogImportItem,
  type CatalogImportResult,
  type ReviewDecision,
} from '../../../../apps/admin/src/catalog.service';
import { AUDIT, PRISMA, LOGGER, APP_CONFIG_TOKEN } from '../tokens';
import type { AuditService } from '../../../../packages/audit/src';
import type { Env } from '../../../../packages/shared/src';

/** One image in an upload batch, waiting to be surfaced to the owner. */
interface QueueEntry {
  kind: 'review' | 'rejected';
  reviewId: string;
  item: CatalogImportItem;
  listing?: GeneratedListing;
  reason?: string;
  createdAt: number;
}

/**
 * Ordered view of a queued entry for the review page (only `review` entries
 * become pages; `rejected` entries surface as "upload a clearer photo").
 */
export interface PendingReview {
  id: string;
  item: CatalogImportItem;
  listing: GeneratedListing;
  createdAt: number;
}

const CATEGORY_VALUES = [
  'Furniture',
  'Carpets',
  'Electronics',
  'Artificial Flowers',
  'Decor & Frames',
] as const;

export type Category = (typeof CATEGORY_VALUES)[number];

const CATEGORIES: Category[] = [...CATEGORY_VALUES];

/**
 * Web companion to the Phase 4 admin CLI catalog import. It is NOT a second
 * implementation: every image goes through the exact same `CatalogService`
 * (apps/admin/src/catalog.service.ts) that the CLI uses — `prepare` runs the
 * AI generation + image-quality gate + rejection audit, `publish` creates the
 * product/stock and audits, `auditReviewRejected` and `applyEdit` are shared
 * too. This service only orchestrates the human review across HTTP requests.
 */
@Injectable()
export class CatalogUploadService {
  private readonly queue = new Map<string, QueueEntry>();
  private catalogService: CatalogService | null = null;
  private businessId!: string;
  private businessCurrency!: string;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(APP_CONFIG_TOKEN) private readonly config: Env,
  ) {}

  getCategories(): Category[] {
    return CATEGORIES;
  }

  getCurrency(): string {
    return this.businessCurrency || this.config.BUSINESS_CURRENCY;
  }

  /** Builds the shared CatalogService on first use (so the API boots without a provider key). */
  private ensureCatalogService(): CatalogService {
    if (this.catalogService) return this.catalogService;

    const apiKey = this.config.GROQ_API_KEY ?? this.config.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY or GEMINI_API_KEY is required to generate catalog listings');
    }

    const llm = createLlmClient({
      groqApiKey: this.config.GROQ_API_KEY,
      groqModel: this.config.GROQ_MODEL,
      groqBaseUrl: this.config.GROQ_BASE_URL,
      groqVisionModel: this.config.GROQ_VISION_MODEL,
      groqAudioModel: this.config.GROQ_AUDIO_MODEL,
      visionApiKey: this.config.VISION_API_KEY,
      visionBaseUrl: this.config.VISION_BASE_URL,
      visionModel: this.config.VISION_MODEL,
      geminiApiKey: this.config.GEMINI_API_KEY,
      geminiModel: this.config.GEMINI_MODEL,
      logger: this.logger.child('llm'),
    });

    this.catalogService = new CatalogService({
      prisma: this.prisma,
      audit: this.audit,
      logger: this.logger,
      generator: new CatalogGenerator(llm, { businessName: this.config.BUSINESS_NAME, currency: this.getCurrency() }),
      // The web flow resolves reviews via submitReview(), never via this
      // callback — a guard so the CLI's auto-publish path can't be triggered.
      reviewer: () => {
        throw new Error('web catalog reviews are resolved via submitReview, not the injected reviewer');
      },
      businessId: this.businessId,
      currency: this.getCurrency(),
    });

    return this.catalogService;
  }

  private async ensureBusiness(): Promise<{ id: string; currency: string; name: string }> {
    if (this.businessId) return { id: this.businessId, currency: this.businessCurrency, name: this.config.BUSINESS_NAME };

    const business = await this.prisma.business.findFirst();
    if (business) {
      this.businessId = business.id;
      this.businessCurrency = business.currency;
      return business;
    }

    const created = await this.prisma.business.create({
      data: {
        name: this.config.BUSINESS_NAME,
        phoneNumber: this.config.BUSINESS_PHONE_NUMBER ?? 'catalog-web',
        currency: this.config.BUSINESS_CURRENCY,
        timezone: this.config.BUSINESS_TIMEZONE,
      },
    });
    this.businessId = created.id;
    this.businessCurrency = created.currency;
    return created;
  }

  /**
   * Runs each uploaded image through the shared `CatalogService.prepare`
   * (generation + quality gate + rejection audit) and queues every entry in
   * order. Returns one result per image so the controller can redirect to the
   * first review (or show the rejection reason immediately).
   */
  async processUpload(
    files: Express.Multer.File[],
    price: number,
    quantity: number,
    category?: string,
    sku?: string,
  ): Promise<{ reviewId: string; result: CatalogImportResult }[]> {
    await this.ensureBusiness();

    const service = this.ensureCatalogService();
    const results: { reviewId: string; result: CatalogImportResult }[] = [];

    for (const file of files) {
      const reviewId = crypto.randomUUID();
      const item: CatalogImportItem = {
        buffer: file.buffer,
        mimeType: file.mimetype,
        filename: file.originalname,
        price,
        quantity,
        category,
        sku,
      };

      const prepared = await service.prepare(item);
      const now = Date.now();

      if (prepared.status === 'image_rejected') {
        this.queue.set(reviewId, { kind: 'rejected', reviewId, item, reason: prepared.reason, createdAt: now });
        results.push({
          reviewId,
          result: { filename: item.filename, ok: false, status: 'image_rejected', reason: prepared.reason },
        });
        continue;
      }

      this.queue.set(reviewId, { kind: 'review', reviewId, item, listing: prepared.listing, createdAt: now });
      results.push({
        reviewId,
        result: { filename: item.filename, ok: true, status: 'generated', listing: prepared.listing },
      });
    }

    return results;
  }

  getPendingReview(reviewId: string): PendingReview | undefined {
    const entry = this.queue.get(reviewId);
    if (!entry || entry.kind !== 'review' || !entry.listing) return undefined;
    return { id: entry.reviewId, item: entry.item, listing: entry.listing, createdAt: entry.createdAt };
  }

  /** First not-yet-consumed entry, in upload order (review or rejection). */
  getNextEntry(): { reviewId: string; kind: 'review' | 'rejected'; item: CatalogImportItem; listing?: GeneratedListing; reason?: string } | undefined {
    for (const entry of this.queue.values()) {
      return { reviewId: entry.reviewId, kind: entry.kind, item: entry.item, listing: entry.listing, reason: entry.reason };
    }
    return undefined;
  }

  /** Consumes an entry once its page has been shown (e.g. a rejection). */
  consume(reviewId: string): void {
    this.queue.delete(reviewId);
  }

  /** Starts a fresh review queue for a new upload (mirrors a fresh CLI run). */
  reset(): void {
    this.queue.clear();
  }

  /**
   * Applies the owner's decision via the shared CatalogService — approve/edit
   * publish through `publish`, reject audits through `auditReviewRejected`.
   */
  async submitReview(reviewId: string, decision: ReviewDecision): Promise<CatalogImportResult> {
    const pending = this.getPendingReview(reviewId);
    if (!pending) throw new Error('Review not found or expired');

    await this.ensureBusiness();
    const service = this.ensureCatalogService();

    if (decision.action === 'reject') {
      await service.auditReviewRejected(pending.item);
      this.queue.delete(reviewId);
      return { filename: pending.item.filename, ok: false, status: 'review_rejected', listing: pending.listing };
    }

    const listing = decision.action === 'edit' ? service.applyEdit(pending.listing, decision) : pending.listing;
    const { productId, sku } = await service.publish(pending.item, listing);
    this.queue.delete(reviewId);

    return { filename: pending.item.filename, ok: true, status: 'generated', listing, productId, sku };
  }

  cleanupExpiredReviews(maxAgeMs = 30 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, entry] of this.queue.entries()) {
      if (now - entry.createdAt > maxAgeMs) this.queue.delete(id);
    }
  }
}
