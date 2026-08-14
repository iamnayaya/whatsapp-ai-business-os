import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

/**
 * Minimal in-memory fixed-window rate limiter. Per-process by design (the API
 * runs as a single instance on the free tier); good enough to stop brute-force
 * login attempts, webhook storms, and health-check abuse. No external deps.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly opts: RateLimiterOptions) {}

  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (this.buckets.size > 1_000) this.sweep(now);
    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.opts.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    if (bucket.count <= this.opts.limit) {
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: false, retryAfterMs: bucket.resetAt - now };
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}

/** NestJS guard wrapping a RateLimiter; 429 with Retry-After when exceeded. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(opts: RateLimiterOptions) {
    this.limiter = new RateLimiter(opts);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const verdict = this.limiter.hit(this.clientKey(req));
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }

  private clientKey(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip;
    return ip ?? 'unknown';
  }
}