import { BadRequestException, Controller, Headers, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PaystackWebhookService } from './paystack-webhook.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

/**
 * Paystack callback endpoint. Paystack sends the RAW body and signs it with
 * HMAC-SHA512 (x-paystack-signature). We verify BEFORE any parsing/processing;
 * an invalid signature is rejected with 401 so nothing is persisted. Returns
 * quickly and defers all work to the payment-events worker.
 */
@Controller('webhook')
@UseGuards(new RateLimitGuard({ limit: 60, windowMs: 60_000 }))
export class PaystackController {
  constructor(private readonly service: PaystackWebhookService) {}

  @Post('paystack')
  async handlePaystack(
    @Req() req: Request,
    @Headers('x-paystack-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = (req as { rawBody?: string | Buffer }).rawBody;
    if (rawBody === undefined) {
      throw new BadRequestException('raw body is required');
    }
    if (!this.service.verifySignature(rawBody, signature)) {
      throw new UnauthorizedException('invalid paystack signature');
    }
    await this.service.handleWebhook(req.body as Parameters<PaystackWebhookService['handleWebhook']>[0]);
    return { received: true };
  }
}