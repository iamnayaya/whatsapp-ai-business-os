import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export interface AdminAuthConfig {
  password: string;
  sessionSecret: string;
  cookieName: string;
  /** Session lifetime in ms (dashboard is for daily 2-minute checks). */
  maxAgeMs: number;
}

/**
 * Minimal stateless auth for the internal owner dashboard. The password comes
 * from env and is compared constant-time (never stored, never logged). Sessions
 * are signed HMAC cookies with an expiry inside the payload — no server-side
 * session store, no write access.
 */
@Injectable()
export class AdminAuthService {
  readonly cookieName: string;
  readonly maxAgeMs: number;

  constructor(private readonly config: AdminAuthConfig) {
    this.cookieName = config.cookieName;
    this.maxAgeMs = config.maxAgeMs;
  }

  /** Constant-time password check against the env-configured password. */
  verifyPassword(candidate: string | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.config.password);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(payload).digest('base64url');
  }

  /** A signed session token: base64url(JSON {exp}) + "." + HMAC. */
  createSession(now = Date.now()): string {
    const payload = JSON.stringify({ exp: now + this.maxAgeMs });
    return `${Buffer.from(payload).toString('base64url')}.${this.sign(payload)}`;
  }

  /** True when the cookie is well-formed, signed, and not expired. */
  verifySession(cookie: string | undefined): boolean {
    if (!cookie) return false;
    const parts = cookie.split('.');
    if (parts.length !== 2) return false;
    const [encodedPayload, signature] = parts;
    let payload: string;
    try {
      payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    } catch {
      return false;
    }
    const expected = Buffer.from(this.sign(payload));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length) return false;
    if (!timingSafeEqual(expected, provided)) return false;
    try {
      const parsed = JSON.parse(payload) as { exp?: number };
      return typeof parsed.exp === 'number' && parsed.exp > Date.now();
    } catch {
      return false;
    }
  }

  /** Reads the session cookie out of a request. */
  readCookie(req: Request): string | undefined {
    const header = req.headers.cookie ?? '';
    const entry = header
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.config.cookieName}=`));
    if (!entry) return undefined;
    try {
      return decodeURIComponent(entry.slice(this.config.cookieName.length + 1));
    } catch {
      return undefined;
    }
  }

  authenticated(req: Request): boolean {
    return this.verifySession(this.readCookie(req));
  }
}