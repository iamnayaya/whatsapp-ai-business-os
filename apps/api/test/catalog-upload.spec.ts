import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {} from 'multer';
import { NotFoundException } from '@nestjs/common';
import { CatalogGenerator } from '../../../packages/ai/src';
import type { GeneratedListing } from '../../../packages/ai/src';
import { CatalogService } from '../../admin/src/catalog.service';
import { CatalogUploadService } from '../src/analytics/catalog-upload.service';
import { CatalogUploadController } from '../src/analytics/catalog-upload.controller';
import { AdminAuthService } from '../src/analytics/admin-auth.service';
import { renderUploadForm, renderImageRejectedPage } from '../src/analytics/catalog-upload.views';
import { createLogger, AUDIT_ACTIONS } from '../../../packages/shared/src';
import type { Env } from '../../../packages/shared/src';
import type { AuditService } from '../../../packages/audit/src';

const goodListing: GeneratedListing = {
  title: 'Handwoven Basket',
  description: 'A beautiful handwoven basket for storage.',
  tags: ['basket', 'storage', 'woven'],
  category: 'Furniture',
};

const silentLogger = createLogger('test', { destination: () => undefined });

function makePrisma() {
  const product = {
    create: vi.fn(async ({ data }: { data: { sku: string } }) => ({ id: `prod-${data.sku}` })),
  };
  const stockLevel = { create: vi.fn(async () => ({ id: 'stock-1' })) };
  const business = {
    findFirst: vi.fn(async () => ({ id: 'biz-1', name: 'Test Shop', currency: 'NGN', timezone: 'Africa/Lagos', phoneNumber: null })),
    create: vi.fn(),
  };
  const agentAction = { create: vi.fn(async () => ({})) };
  const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ product, stockLevel }));
  return { product, stockLevel, business, agentAction, $transaction };
}

function makeAudit() {
  return { record: vi.fn(async () => undefined) };
}

function makeConfig(): Env {
  return {
    NODE_ENV: 'test',
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-test',
    BUSINESS_NAME: 'Test Shop',
    BUSINESS_PHONE_NUMBER: '123',
    BUSINESS_CURRENCY: 'NGN',
    BUSINESS_TIMEZONE: 'Africa/Lagos',
  } as Env;
}

function makeFile(filename: string): Express.Multer.File {
  return { originalname: filename, mimetype: 'image/jpeg', buffer: Buffer.from('fake-image-bytes'), size: 16 } as Express.Multer.File;
}

function makeUploadService() {
  const prisma = makePrisma();
  const audit = makeAudit();
  const service = new CatalogUploadService(prisma as never, audit as unknown as AuditService, silentLogger, makeConfig());
  return { service, prisma, audit };
}

afterEach(() => vi.restoreAllMocks());

describe('CatalogUploadService — web catalog form (reuses the CLI CatalogService)', () => {
  it('publishes a product through the form flow: prepare -> review -> publish', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: true, listing: goodListing } as never);
    const { service, prisma, audit } = makeUploadService();

    const results = await service.processUpload([makeFile('photo.jpg')], 50000, 10, 'Furniture', 'SKU-X');
    expect(results).toHaveLength(1);
    expect(results[0].result.status).toBe('generated');
    expect(results[0].result.listing).toEqual(goodListing);

    const out = await service.submitReview(results[0].reviewId, { action: 'approve' });

    expect(out.status).toBe('generated');
    expect(out.sku).toBe('SKU-X');
    expect(out.productId).toBe('prod-SKU-X');
    expect(prisma.product.create).toHaveBeenCalledTimes(1);
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Handwoven Basket',
          price: 50000,
          sku: 'SKU-X',
          isActive: true,
          category: 'Furniture',
        }),
      }),
    );
    expect(prisma.stockLevel.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity: 10, reserved: 0 }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.PRODUCT_CREATED }));
    // review consumed, so nothing is queued for the next step
    expect(service.getNextEntry()).toBeUndefined();
  });

  it('rejects a blurry photo with the same reason as the CLI and audits it (nothing published)', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: false, reason: 'Image is too blurry.' } as never);
    const { service, prisma, audit } = makeUploadService();

    const results = await service.processUpload([makeFile('blurry.jpg')], 50000, 10, 'Furniture');

    expect(results[0].result.status).toBe('image_rejected');
    expect(results[0].result.reason).toBe('Image is too blurry.');
    expect(service.getPendingReview(results[0].reviewId)).toBeUndefined();
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AUDIT_ACTIONS.CATALOG_IMAGE_REJECTED, details: expect.objectContaining({ reason: 'Image is too blurry.' }) }),
    );

    const html = renderImageRejectedPage('blurry.jpg', 'Image is too blurry.', { price: '50000', quantity: '10', category: 'Furniture' }, ['Furniture'], 'nonce123');
    expect(html).toContain('Image rejected: Image is too blurry. Please upload a clearer photo.');
    expect(html).toContain('value="50000"');
    expect(html).toContain('value="10"');
    expect(html).toContain('<option value="Furniture" selected>');
    expect(html).toContain('nonce="nonce123"');
  });

  it('honours a human reject decision — never auto-publishes', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: true, listing: goodListing } as never);
    const { service, prisma, audit } = makeUploadService();

    const results = await service.processUpload([makeFile('photo.jpg')], 50000, 10);
    const out = await service.submitReview(results[0].reviewId, { action: 'reject' });

    expect(out.status).toBe('review_rejected');
    expect(prisma.product.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.CATALOG_REVIEWED }));
  });

  it('applies a human edit to title/description before publishing', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: true, listing: goodListing } as never);
    const { service, prisma } = makeUploadService();

    const results = await service.processUpload([makeFile('photo.jpg')], 50000, 10);
    const out = await service.submitReview(results[0].reviewId, {
      action: 'edit',
      title: 'Round Woven Basket',
      description: 'A round, handwoven basket — perfect for the living room.',
      tags: ['basket'],
      category: 'Decor & Frames',
    });

    expect(out.status).toBe('generated');
    expect(prisma.product.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Round Woven Basket',
          description: 'A round, handwoven basket — perfect for the living room.',
          category: 'Decor & Frames',
        }),
      }),
    );
  });

  it('steps through multiple images in upload order, surfacing a mid-batch rejection', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate')
      .mockResolvedValueOnce({ usable: true, listing: goodListing } as never)
      .mockResolvedValueOnce({ usable: false, reason: 'Photo is too dark.' } as never)
      .mockResolvedValueOnce({ usable: true, listing: goodListing } as never);
    const { service, prisma, audit } = makeUploadService();

    const results = await service.processUpload([makeFile('a.jpg'), makeFile('dark.jpg'), makeFile('c.jpg')], 5000, 2);
    expect(results.map(r => r.result.status)).toEqual(['generated', 'image_rejected', 'generated']);

    // review #1 -> next entry is the rejection
    await service.submitReview(results[0].reviewId, { action: 'approve' });
    const next = service.getNextEntry();
    expect(next?.kind).toBe('rejected');
    expect(next?.reason).toBe('Photo is too dark.');
    service.consume(next!.reviewId);

    // review #3 -> batch complete
    await service.submitReview(results[2].reviewId, { action: 'approve' });
    expect(prisma.product.create).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: AUDIT_ACTIONS.CATALOG_IMAGE_REJECTED }));
    expect(service.getNextEntry()).toBeUndefined();
  });

  it('calls the exact same underlying CatalogService as the CLI — identical DB writes and audits', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: true, listing: goodListing } as never);

    const prisma = makePrisma();
    const audit = makeAudit();

    // CLI path — the Phase 4 admin CLI flow (importImages + approve reviewer).
    const cli = new CatalogService({
      prisma: prisma as never,
      audit: audit as unknown as AuditService,
      logger: silentLogger,
      generator: new CatalogGenerator({ analyzeImage: vi.fn() } as never, { businessName: 'Test Shop', currency: 'NGN' }),
      reviewer: () => ({ action: 'approve' }),
      businessId: 'biz-1',
      currency: 'NGN',
    });
    await cli.importImages([{ buffer: Buffer.from('img'), mimeType: 'image/jpeg', filename: 'photo.jpg', price: 50000, quantity: 10, category: 'Furniture', sku: 'SKU-X' }]);

    const cliProductCalls = prisma.product.create.mock.calls;
    const cliStockCalls = prisma.stockLevel.create.mock.calls;
    const cliAuditCalls = audit.record.mock.calls;

    prisma.product.create.mockClear();
    prisma.stockLevel.create.mockClear();
    audit.record.mockClear();

    // Web path — the browser form flow against the same stubs.
    const web = new CatalogUploadService(prisma as never, audit as unknown as AuditService, silentLogger, makeConfig());
    const results = await web.processUpload([makeFile('photo.jpg')], 50000, 10, 'Furniture', 'SKU-X');
    await web.submitReview(results[0].reviewId, { action: 'approve' });

    expect(prisma.product.create.mock.calls).toEqual(cliProductCalls);
    expect(prisma.stockLevel.create.mock.calls).toEqual(cliStockCalls);
    expect(audit.record.mock.calls).toEqual(cliAuditCalls);
  });

  it('has no duplicated business logic — generation, validation, and audit live in the shared service', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'analytics', 'catalog-upload.service.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/apps\/admin\/src\/catalog\.service'/);
    expect(source).toMatch(/service\.prepare\(/);
    expect(source).toMatch(/service\.publish\(/);
    expect(source).not.toMatch(/product\.create/);
    expect(source).not.toMatch(/stockLevel\.create/);
    expect(source).not.toMatch(/\.generate\(/);
    expect(source).not.toMatch(/CATALOG_IMAGE_REJECTED|CATALOG_REVIEWED|PRODUCT_CREATED/);
    expect(source).not.toMatch(/AUDIT_ACTOR/);
  });
});

describe('CatalogUploadService — rendering', () => {
  it('escapes user-supplied values in the form (XSS-safe escaper)', () => {
    const html = renderUploadForm(['Furniture'], undefined, { price: '"><script>alert(1)</script>', sku: 'x&y' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('x&amp;y');
  });

  it('has no hardcoded hex colors outside the brand theme file', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'analytics', 'catalog-upload.views.ts'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).toMatch(/var\(--brand-primary\)/);
    expect(source).toMatch(/var\(--brand-base\)/);
  });
});

describe('CatalogUploadController — routes', () => {
  const auth = new AdminAuthService({ password: 'pw', sessionSecret: 'secret', cookieName: 'wabiz_admin', maxAgeMs: 1000 });
  const session = auth.createSession(Date.now());

  function fakeRes() {
    const res: Record<string, unknown> & { headers: Record<string, string>; redirected?: string; body?: string; locals?: { cspNonce?: string } } = { headers: {}, locals: { cspNonce: 'nonce123' } };
    res.setHeader = (k: string, v: string) => {
      res.headers[k] = v;
    };
    res.redirect = (url: string) => {
      res.redirected = url;
    };
    res.send = (body: string) => {
      res.body = body;
    };
    return res;
  }

  const fakeReq = (cookie?: string) => ({ headers: { cookie } } as never);

  it('redirects an unauthenticated browser to the login page', () => {
    const ctrl = new CatalogUploadController(auth, makeUploadService().service);
    const res = fakeRes();
    ctrl.uploadForm(fakeReq(), res as never);
    expect(res.redirected).toBe('/admin/login');
  });

  it('404s every route when admin is disabled (no ADMIN_PASSWORD)', () => {
    const ctrl = new CatalogUploadController(null, makeUploadService().service);
    const res = fakeRes();
    expect(() => ctrl.uploadForm(fakeReq(), res as never)).toThrow(NotFoundException);
  });

  it('renders the upload form once authenticated', () => {
    const ctrl = new CatalogUploadController(auth, makeUploadService().service);
    const res = fakeRes();
    ctrl.uploadForm(fakeReq(`wabiz_admin=${session}`), res as never);
    expect(res.body).toContain('Add New Products');
    expect(res.body).toContain('multiple');
    expect(res.body).toContain('Furniture');
    expect(res.body).toContain('capture="environment"');
  });

  it('redirects to the first review after a successful multi-image upload', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: true, listing: goodListing } as never);
    const { service } = makeUploadService();
    const ctrl = new CatalogUploadController(auth, service);
    const res = fakeRes();
    await ctrl.uploadImages(fakeReq(`wabiz_admin=${session}`), res as never, [makeFile('a.jpg'), makeFile('b.jpg')], { price: '5000', quantity: '2' });
    expect(res.redirected).toMatch(/^\/admin\/catalog\/review\//);
  });

  it('shows the rejection reason and preserves entered fields when the photo is unusable', async () => {
    vi.spyOn(CatalogGenerator.prototype, 'generate').mockResolvedValue({ usable: false, reason: 'Unclear.' } as never);
    const { service } = makeUploadService();
    const ctrl = new CatalogUploadController(auth, service);
    const res = fakeRes();
    await ctrl.uploadImages(fakeReq(`wabiz_admin=${session}`), res as never, [makeFile('blur.jpg')], { price: '5000', quantity: '2', category: 'Carpets' });
    expect(res.body).toContain('Image rejected: Unclear. Please upload a clearer photo.');
    expect(res.body).toContain('value="5000"');
    expect(res.body).toContain('value="2"');
    expect(res.body).toContain('<option value="Carpets" selected>');
  });
});
