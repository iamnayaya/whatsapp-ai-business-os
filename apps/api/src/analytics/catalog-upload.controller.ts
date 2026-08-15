import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, Res, UseGuards, UploadedFiles, UseInterceptors } from '@nestjs/common';
import type {} from 'multer';
import type { Request, Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { ReviewDecision } from '../../../../apps/admin/src/catalog.service';
import { AdminAuthService } from './admin-auth.service';
import { CatalogUploadService } from './catalog-upload.service';
import { renderUploadForm, renderReviewPage, renderSuccessPage, renderImageRejectedPage } from './catalog-upload.views';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

interface CatalogBody {
  price?: string;
  quantity?: string;
  category?: string;
  sku?: string;
}

@Controller('admin/catalog')
export class CatalogUploadController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService | null,
    private readonly uploadService: CatalogUploadService,
  ) {}

  private assertEnabled(): void {
    if (!this.auth) throw new NotFoundException('Admin disabled (ADMIN_PASSWORD not set)');
  }

  private requireAuth(req: Request, res: Response): boolean {
    this.assertEnabled();
    if (!this.auth!.authenticated(req)) {
      res.redirect('/admin/login');
      return false;
    }
    return true;
  }

  private send(res: Response, html: string): void {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  /** CSP nonce minted in main.ts for /admin/catalog pages (inline script). */
  private nonce(res: Response): string {
    return (res as unknown as { locals?: { cspNonce?: string } }).locals?.cspNonce ?? '';
  }

  @Get('new')
  uploadForm(@Req() req: Request, @Res() res: Response): void {
    if (!this.requireAuth(req, res)) return;
    this.send(res, renderUploadForm(this.uploadService.getCategories(), undefined, undefined, this.nonce(res)));
  }

  @Post('new')
  @UseGuards(new RateLimitGuard({ limit: 10, windowMs: 60_000 }))
  @UseInterceptors(FilesInterceptor('images', 20, { limits: { fileSize: 10 * 1024 * 1024 } }))
  async uploadImages(
    @Req() req: Request,
    @Res() res: Response,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: CatalogBody,
  ): Promise<void> {
    if (!this.requireAuth(req, res)) return;
    const nonce = this.nonce(res);

    if (!files || files.length === 0) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Please select at least one image.', body, nonce));
      return;
    }

    const price = Number(body.price);
    const quantity = Number(body.quantity);

    if (!Number.isFinite(price) || price < 0) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Price must be a valid number.', body, nonce));
      return;
    }

    if (!Number.isInteger(quantity) || quantity < 0) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Quantity must be a non-negative whole number.', body, nonce));
      return;
    }

    const category = body.category?.trim() || undefined;
    const sku = body.sku?.trim() || undefined;

    try {
      // Each upload starts a fresh review queue (mirrors a fresh CLI run).
      this.uploadService.reset();

      const results = await this.uploadService.processUpload(files, price, quantity, category, sku);

      const first = results[0];
      if (first.result.status === 'image_rejected') {
        this.send(res, renderImageRejectedPage(first.result.filename, first.result.reason ?? 'Image quality insufficient', body, this.uploadService.getCategories(), nonce));
        return;
      }

      res.redirect(`/admin/catalog/review/${first.reviewId}`);
    } catch (err) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Upload failed. Please try again.', body, nonce));
    }
  }

  @Get('review/:reviewId')
  reviewPage(@Req() req: Request, @Res() res: Response, @Param('reviewId') reviewId: string): void {
    if (!this.requireAuth(req, res)) return;

    const pending = this.uploadService.getPendingReview(reviewId);
    if (!pending) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Review not found or expired. Please upload again.', undefined, this.nonce(res)));
      return;
    }

    this.send(res, renderReviewPage(reviewId, pending.listing, pending.item.filename, 2, 3, undefined, undefined, this.uploadService.getCategories()));
  }

  @Post('review/:reviewId')
  @UseGuards(new RateLimitGuard({ limit: 20, windowMs: 60_000 }))
  async submitReview(
    @Req() req: Request,
    @Res() res: Response,
    @Param('reviewId') reviewId: string,
    @Body() body: { action?: 'approve' | 'edit' | 'reject'; title?: string; description?: string; tags?: string; category?: string },
  ): Promise<void> {
    if (!this.requireAuth(req, res)) return;

    const pending = this.uploadService.getPendingReview(reviewId);
    if (!pending) {
      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Review not found or expired. Please upload again.', undefined, this.nonce(res)));
      return;
    }

    try {
      let decision: ReviewDecision;
      if (body.action === 'reject') {
        decision = { action: 'reject' };
      } else if (body.action === 'edit') {
        const description = body.description?.trim();
        if (!description) {
          this.send(res, renderReviewPage(reviewId, pending.listing, pending.item.filename, 2, 3, 'Description is required when editing.', { title: body.title, description: body.description, tags: body.tags?.split(',').map(t => t.trim()).filter(Boolean), category: body.category }, this.uploadService.getCategories()));
          return;
        }
        decision = {
          action: 'edit',
          description,
          title: body.title?.trim(),
          tags: body.tags?.split(',').map(t => t.trim()).filter(Boolean),
          category: body.category?.trim(),
        };
      } else {
        decision = { action: 'approve' };
      }

      const result = await this.uploadService.submitReview(reviewId, decision);

      const next = this.uploadService.getNextEntry();
      if (next?.kind === 'rejected') {
        this.uploadService.consume(next.reviewId);
        this.send(res, renderImageRejectedPage(
          next.item.filename,
          next.reason ?? 'Image quality insufficient',
          { price: String(next.item.price), quantity: String(next.item.quantity), category: next.item.category, sku: next.item.sku },
          this.uploadService.getCategories(),
          this.nonce(res),
        ));
        return;
      }
      if (next?.kind === 'review') {
        res.redirect(`/admin/catalog/review/${next.reviewId}`);
        return;
      }

      if (result.status === 'generated') {
        this.send(res, renderSuccessPage({
          title: result.listing!.title,
          sku: result.sku!,
          price: pending.item.price,
          quantity: pending.item.quantity,
          category: result.listing?.category,
        }, this.uploadService.getCurrency()));
        return;
      }
      if (result.status === 'review_rejected') {
        this.send(res, renderUploadForm(this.uploadService.getCategories(), 'Listing rejected. You can upload another product.', undefined, this.nonce(res)));
        return;
      }

      this.send(res, renderUploadForm(this.uploadService.getCategories(), 'An unexpected error occurred. Please try again.', undefined, this.nonce(res)));
    } catch (err) {
      this.send(res, renderReviewPage(reviewId, pending.listing, pending.item.filename, 2, 3, 'Review submission failed. Please try again.', undefined, this.uploadService.getCategories()));
    }
  }
}
