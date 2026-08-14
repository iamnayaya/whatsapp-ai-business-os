import { Body, Controller, Get, Inject, NotFoundException, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { createKillSwitch, KILL_SWITCH_REPLY_TEXT, type KillSwitch } from '../../../../packages/ops/src';
import type { Env } from '../../../../packages/shared/src';
import { APP_CONFIG_TOKEN, KILL_SWITCH } from '../tokens';
import { AdminAuthService } from '../analytics/admin-auth.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

interface KillSwitchBody {
  enabled: boolean;
  /** Pause for this many seconds; omit/0 = paused until explicitly resumed. */
  ttlSeconds?: number;
  /** One-shot auth: the admin password (for curl). Prefer a session cookie. */
  password?: string;
}

/**
 * AI-agent kill switch (Phase 9). Protected by the same admin auth as the
 * dashboard. When enabled, the WORKER answers every customer message with the
 * static fallback and stops calling Gemini — webhooks, payments, and
 * follow-ups keep running. Toggling here does NOT restart anything.
 */
@Controller('admin/ops/kill-switch')
export class OpsController {
  constructor(
    @Inject(KILL_SWITCH) private readonly killSwitch: KillSwitch,
    @Inject(AdminAuthService) private readonly auth: AdminAuthService | null,
    @Inject(APP_CONFIG_TOKEN) private readonly config: Env,
  ) {}

  @Get()
  async status(@Req() req: Request): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(req);
    const state = await this.killSwitch.status();
    return { ok: true, ...state, fallbackMessage: KILL_SWITCH_REPLY_TEXT };
  }

  @Post()
  @UseGuards(new RateLimitGuard({ limit: 10, windowMs: 60_000 }))
  async set(@Req() req: Request, @Body() body: KillSwitchBody): Promise<Record<string, unknown>> {
    this.assertEnabledAndAuthorized(req, body.password);
    if (body.enabled) {
      await this.killSwitch.activate(body.ttlSeconds);
    } else {
      await this.killSwitch.deactivate();
    }
    const state = await this.killSwitch.status();
    return { ok: true, ...state, fallbackMessage: KILL_SWITCH_REPLY_TEXT };
  }

  private assertEnabledAndAuthorized(req: Request, password?: string): void {
    if (!this.auth) throw new NotFoundException('Admin disabled (ADMIN_PASSWORD not set)');
    const authorized = this.auth.authenticated(req) || (password !== undefined && this.auth.verifyPassword(password));
    if (!authorized) throw new UnauthorizedException('Not authorized');
  }
}