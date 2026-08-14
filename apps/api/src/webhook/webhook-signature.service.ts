import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

export interface WebhookSignatureConfig {
  appSecret: string;
  verifyToken: string;
}

@Injectable()
export class WebhookSignatureService {
  constructor(private readonly config: WebhookSignatureConfig) {}

  get verifyToken(): string {
    return this.config.verifyToken;
  }

  /**
   * Verify the X-Hub-Signature-256 header: `sha256=<hex hmac-sha256(appSecret, rawBody)>`.
   * Uses a constant-time comparison to avoid timing side-channels.
   */
  verify(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const expected = createHmac('sha256', this.config.appSecret).update(rawBody).digest();
    const provided = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  }
}