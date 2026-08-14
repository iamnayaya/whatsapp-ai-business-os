import { Body, BadRequestException, Controller, Get, Post, Query, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ZodError } from 'zod';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { WebhookSignatureService } from './webhook-signature.service';
import { WebhookService } from './webhook.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@Controller('webhook/whatsapp')
@UseGuards(new RateLimitGuard({ limit: 120, windowMs: 60_000 }))
export class WebhookController {
  constructor(
    private readonly signature: WebhookSignatureService,
    private readonly service: WebhookService,
  ) {}

  /**
   * Meta webhook verification handshake.
   * Meta GETs ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
   * and expects the challenge echoed back verbatim.
   */
  @Get()
  verify(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
  ): string {
    if (mode !== 'subscribe' || !this.constantTimeEquals(token, this.signature.verifyToken)) {
      throw new UnauthorizedException('Webhook verification failed');
    }
    return challenge ?? '';
  }

  /**
   * Webhook event receiver. Signature is verified against the raw body.
   * Duplicate deliveries are idempotent (no double-ingest). Malformed payloads
   * are rejected with 400 so Meta does not retry what can never parse.
   */
  @Post()
  async receive(@Req() req: Request, @Body() body: unknown): Promise<{ received: boolean }> {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body));
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (typeof signatureHeader !== 'string' || !this.signature.verify(rawBody, signatureHeader)) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256');
    }
    try {
      await this.service.handleWebhook(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException('Malformed webhook payload');
      }
      throw err;
    }
    return { received: true };
  }

  private constantTimeEquals(a: string | undefined, b: string): boolean {
    if (!a) return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    if (x.length !== y.length) return false;
    return timingSafeEqual(x, y);
  }
}