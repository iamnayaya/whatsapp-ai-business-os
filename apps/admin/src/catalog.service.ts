import { Prisma, type PrismaClient } from '../../../packages/db/src';
import type { AppLogger } from '../../../packages/shared/src';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR,
  messageFromError,
} from '../../../packages/shared/src';
import type { AuditService } from '../../../packages/audit/src';
import type { CatalogGenerator, CatalogGenerationResult, GeneratedListing } from '../../../packages/ai/src';
export type { GeneratedListing } from '../../../packages/ai/src';

export interface CatalogImportItem {
  /** Source image bytes. */
  buffer: Buffer;
  mimeType: string;
  /** Human label for the image (file name) — used in logs/summary. */
  filename: string;
  price: number;
  quantity: number;
  category?: string;
  sku?: string;
}

export type ReviewDecision =
  | { action: 'approve' }
  | { action: 'edit'; description: string; title?: string; tags?: string[]; category?: string }
  | { action: 'reject' };

export interface CatalogImportResult {
  filename: string;
  ok: boolean;
  status: 'generated' | 'image_rejected' | 'review_rejected' | 'error';
  listing?: GeneratedListing;
  productId?: string;
  sku?: string;
  reason?: string;
}

export interface CatalogImportSummary {
  total: number;
  published: number;
  imageRejected: number;
  reviewRejected: number;
  failed: number;
  items: CatalogImportResult[];
}

/** Result of the shared generation + image-quality gate (CLI + admin web form). */
export type PreparedImage =
  | { status: 'ready'; listing: GeneratedListing }
  | { status: 'image_rejected'; reason: string };

export interface CatalogServiceDeps {
  prisma: PrismaClient;
  audit: AuditService;
  logger: AppLogger;
  generator: CatalogGenerator;
  /**
   * Review gate (requirement: never auto-publish). Receives the AI listing and
   * the item; returns the human decision. The CLI wires this to a terminal
   * prompt; tests inject a deterministic stub.
   */
  reviewer: (input: { filename: string; listing: GeneratedListing }) => Promise<ReviewDecision> | ReviewDecision;
  businessId: string;
  currency: string;
}

const COUNTER_OFFSET = 7_000_000_000; // cuid-safe-ish numeric-ish suffix

/**
 * Bulk catalog import with a per-item review gate and a progress summary.
 *
 * Flow per item: AI generate (quality-gated) -> human review/edit/reject ->
 * publish as isActive product + stock level -> audit. Images that fail the
 * quality gate are never published and never hallucinated.
 *
 * The per-item steps (`prepare`, `publish`, `auditReviewRejected`, `applyEdit`)
 * are public so the Phase 4 admin CLI AND the admin web upload form share the
 * exact same AI generation, image validation, and audit logic — neither side
 * reimplements the business rules.
 */
export class CatalogService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  async importImages(items: CatalogImportItem[]): Promise<CatalogImportSummary> {
    const summary: CatalogImportSummary = { total: items.length, published: 0, imageRejected: 0, reviewRejected: 0, failed: 0, items: [] };

    for (const [index, item] of items.entries()) {
      let result: CatalogImportResult;
      try {
        result = await this.importOne(item, index);
      } catch (err) {
        this.deps.logger.error('catalog import item failed', { filename: item.filename, error: messageFromError(err) });
        result = { filename: item.filename, ok: false, status: 'error', reason: messageFromError(err) };
      }

      summary.items.push(result);
      if (result.status === 'generated') summary.published += 1;
      else if (result.status === 'image_rejected') summary.imageRejected += 1;
      else if (result.status === 'review_rejected') summary.reviewRejected += 1;
      else summary.failed += 1;
    }

    return summary;
  }

  private async importOne(item: CatalogImportItem, index: number): Promise<CatalogImportResult> {
    const prepared = await this.prepare(item);
    if (prepared.status === 'image_rejected') {
      return { filename: item.filename, ok: false, status: 'image_rejected', reason: prepared.reason };
    }

    // Human review gate — never auto-publish.
    const decision = await this.deps.reviewer({ filename: item.filename, listing: prepared.listing });

    if (decision.action === 'reject') {
      await this.auditReviewRejected(item);
      return { filename: item.filename, ok: false, status: 'review_rejected', listing: prepared.listing };
    }

    const listing = decision.action === 'edit' ? this.applyEdit(prepared.listing, decision) : prepared.listing;
    const { productId, sku } = await this.publish(item, listing, item.sku ?? CatalogService.suggestSku(index));
    return { filename: item.filename, ok: true, status: 'generated', listing, productId, sku };
  }

  /** Auto-SKU for when the owner didn't supply one — unique enough per run. */
  static suggestSku(seed: number): string {
    return `AUTO-${Date.now().toString(36).toUpperCase()}-${seed + COUNTER_OFFSET}`;
  }

  /**
   * Shared step 1 (CLI + admin web form): AI generation + image-quality gate.
   * A photo the model flags `usable:false` is audited as CATALOG_IMAGE_REJECTED
   * and returned as `image_rejected` — it is never published.
   */
  async prepare(item: CatalogImportItem): Promise<PreparedImage> {
    const generated: CatalogGenerationResult = await this.deps.generator.generate({
      buffer: item.buffer,
      mimeType: item.mimeType,
      info: { price: item.price, quantity: item.quantity, category: item.category, sku: item.sku },
    });

    if (!generated.usable || !generated.listing) {
      await this.deps.audit.record({
        businessId: this.deps.businessId,
        actorType: AUDIT_ACTOR.AI_AGENT,
        action: AUDIT_ACTIONS.CATALOG_IMAGE_REJECTED,
        entityType: 'PRODUCT',
        details: { filename: item.filename, reason: generated.reason },
      });
      this.deps.logger.warn('catalog image rejected', { filename: item.filename, reason: generated.reason });
      return { status: 'image_rejected', reason: generated.reason ?? 'Image quality insufficient' };
    }

    return { status: 'ready', listing: generated.listing };
  }

  /**
   * Shared step 2 (CLI + admin web form): publish an approved listing. Creates
   * the active Product + StockLevel in one transaction and audits
   * PRODUCT_CREATED. Returns the published product id and the final SKU.
   */
  async publish(item: CatalogImportItem, listing: GeneratedListing, sku?: string): Promise<{ productId: string; sku: string }> {
    const finalSku = sku ?? item.sku ?? CatalogService.suggestSku(Math.floor(Math.random() * 1_000_000));

    const product = await this.deps.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          businessId: this.deps.businessId,
          sku: finalSku,
          name: listing.title,
          description: listing.description,
          price: item.price,
          currency: this.deps.currency,
          category: listing.category || null,
          imageUrl: null,
          isActive: true, // immediately searchable by search_products
          metadata: { tags: listing.tags, source: 'catalog-import', filename: item.filename } as Prisma.InputJsonValue,
        },
      });
      await tx.stockLevel.create({
        data: { productId: created.id, quantity: item.quantity, reserved: 0 },
      });
      return created;
    });

    await this.deps.audit.record({
      businessId: this.deps.businessId,
      actorType: AUDIT_ACTOR.OWNER,
      action: AUDIT_ACTIONS.PRODUCT_CREATED,
      entityType: 'PRODUCT',
      entityId: product.id,
      details: { filename: item.filename, sku: finalSku, title: listing.title, category: listing.category },
    });
    this.deps.logger.info('catalog item published', { filename: item.filename, sku: finalSku, productId: product.id });

    return { productId: product.id, sku: finalSku };
  }

  /** Shared audit for a human review-reject decision (CLI + admin web form). */
  async auditReviewRejected(item: CatalogImportItem): Promise<void> {
    await this.deps.audit.record({
      businessId: this.deps.businessId,
      actorType: AUDIT_ACTOR.OWNER,
      action: AUDIT_ACTIONS.CATALOG_REVIEWED,
      entityType: 'PRODUCT',
      details: { filename: item.filename, decision: 'reject' },
    });
  }

  applyEdit(base: GeneratedListing, decision: Extract<ReviewDecision, { action: 'edit' }>): GeneratedListing {
    return {
      title: decision.title?.trim() || base.title,
      description: decision.description.trim() || base.description,
      tags: decision.tags && decision.tags.length > 0 ? decision.tags : base.tags,
      category: decision.category?.trim() || base.category,
    };
  }
}

export function createCatalogService(deps: CatalogServiceDeps): CatalogService {
  return new CatalogService(deps);
}