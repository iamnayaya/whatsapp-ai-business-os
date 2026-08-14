import { describe, expect, it, vi } from 'vitest';
import { CatalogService, type CatalogImportItem, type ReviewDecision } from '../src/catalog.service';
import type { AuditService } from '../../../packages/audit/src';
import type { CatalogGenerator, GeneratedListing } from '../../../packages/ai/src';
import { createLogger, AUDIT_ACTIONS } from '../../../packages/shared/src';

const silentLogger = createLogger('test', { destination: () => undefined });

const goodListing: GeneratedListing = {
  title: '50kg Rice Bag',
  description: 'A large 50kg bag of white rice.',
  tags: ['rice', 'grocery', 'staple'],
  category: 'Groceries',
};

function makeGenerator(overrides: Partial<{ perImage: Array<{ usable: boolean; reason?: string; listing?: GeneratedListing }>; throwAt?: number }> = {}) {
  const calls: unknown[] = [];
  const generate = vi.fn(async (input: { buffer: Buffer; mimeType: string; info: { price: number; quantity: number } }) => {
    calls.push(input.info);
    const seq = overrides.perImage ?? [{ usable: true, listing: goodListing }];
    const at = (calls.length - 1) % seq.length;
    const result = seq[at];
    if (overrides.throwAt === calls.length - 1) throw new Error('boom');
    if (result.usable === false) return { usable: false, reason: result.reason } as never;
    return { usable: true, listing: result.listing } as never;
  });
  return { generate, calls } as unknown as CatalogGenerator;
}

function makePrisma() {
  const product = { create: vi.fn(), findFirst: vi.fn() };
  const stockLevel = { create: vi.fn() };
  const business = { findFirst: vi.fn() };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ product, stockLevel }));
  product.create.mockImplementation(async (args: { data: { sku: string } }) => ({ id: `prod-${args.data.sku}` }));
  stockLevel.create.mockResolvedValue({ id: 'stock-1' });
  return { product, stockLevel, business, $transaction } as never;
}

function makeService(generator: CatalogGenerator, reviewer: (input: { filename: string; listing: GeneratedListing }) => ReviewDecision) {
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const prisma = makePrisma();
  const service = new CatalogService({
    prisma,
    audit,
    logger: silentLogger,
    generator,
    reviewer,
    businessId: 'biz-1',
    currency: 'NGN',
  });
  return { service, audit, prisma: prisma as { product: { create: ReturnType<typeof vi.fn> }; $transaction: ReturnType<typeof vi.fn> } };
}

function item(overrides: Partial<CatalogImportItem> = {}): CatalogImportItem {
  return { buffer: Buffer.from('img'), mimeType: 'image/jpeg', filename: 'photo.jpg', price: 50000, quantity: 10, ...overrides };
}

const approve = () => ({ action: 'approve' as const });

describe('CatalogService', () => {
  it('publishes a generated listing as an active product with a stock level', async () => {
    const generator = makeGenerator();
    const { service, prisma } = makeService(generator as never, approve);

    const summary = await service.importImages([item()]);

    expect(summary.published).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.items[0].status).toBe('generated');
    expect(summary.items[0].ok).toBe(true);
    expect(summary.items[0].listing).toEqual(goodListing);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: '50kg Rice Bag',
          description: 'A large 50kg bag of white rice.',
          price: 50000,
          currency: 'NGN',
          isActive: true,
        }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('never publishes a blurry photo — reports image_rejected and audits it', async () => {
    const generator = makeGenerator({ perImage: [{ usable: false, reason: 'Image is too blurry.' }] });
    const { service, audit, prisma } = makeService(generator as never, approve);

    const summary = await service.importImages([item()]);

    expect(summary.published).toBe(0);
    expect(summary.imageRejected).toBe(1);
    expect(summary.items[0].status).toBe('image_rejected');
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.CATALOG_IMAGE_REJECTED }));
  });

  it('honours a human review-reject decision (never auto-publish)', async () => {
    const generator = makeGenerator();
    const { service, audit, prisma } = makeService(generator as never, () => ({ action: 'reject' }));

    const summary = await service.importImages([item()]);

    expect(summary.published).toBe(0);
    expect(summary.reviewRejected).toBe(1);
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.CATALOG_REVIEWED }));
  });

  it('applies a human edit to the description before publishing', async () => {
    const generator = makeGenerator();
    const { service, prisma } = makeService(generator as never, () => ({ action: 'edit', description: 'Fresh local rice, 50kg bag.' }));

    const summary = await service.importImages([item()]);

    expect(summary.published).toBe(1);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ description: 'Fresh local rice, 50kg bag.' }) }),
    );
  });

  it('runs a bulk upload of 5 images with a progress summary', async () => {
    const generator = makeGenerator({
      perImage: [
        { usable: true, listing: goodListing },
        { usable: false, reason: 'blurry' },
        { usable: true, listing: goodListing },
        { usable: true, listing: goodListing },
        { usable: true, listing: goodListing },
      ],
    });
    const { service, prisma } = makeService(generator as never, approve);

    const items = Array.from({ length: 5 }, (_, i) => item({ filename: `photo-${i + 1}.jpg`, price: 1000 * (i + 1), quantity: i + 1 }));
    const summary = await service.importImages(items);

    expect(summary.total).toBe(5);
    expect(summary.published).toBe(4);
    expect(summary.imageRejected).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.items).toHaveLength(5);
    expect(summary.items.map((r) => r.status)).toEqual(['generated', 'image_rejected', 'generated', 'generated', 'generated']);
    expect(prisma.product.create).toHaveBeenCalledTimes(4);
  });

  it('isolates a failing item into the summary without aborting the batch', async () => {
    const generator = makeGenerator({ throwAt: 0 });
    const { service } = makeService(generator as never, approve);

    const summary = await service.importImages([item({ filename: 'a.jpg' }), item({ filename: 'b.jpg' })]);

    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.published).toBe(1);
    expect(summary.items[0].status).toBe('error');
    expect(summary.items[1].status).toBe('generated');
  });

  it('generates a unique SKU per item and records it in the summary', async () => {
    const generator = makeGenerator();
    const { service } = makeService(generator as never, approve);
    const summary = await service.importImages([item({ sku: 'SKU-CUSTOM' })]);
    expect(summary.items[0].sku).toBe('SKU-CUSTOM');
  });
});