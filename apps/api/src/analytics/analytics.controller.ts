import { Body, Controller, Get, Inject, NotFoundException, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AnalyticsService } from '../../../../packages/analytics/src';
import type { Env } from '../../../../packages/shared/src';
import { APP_CONFIG_TOKEN } from '../tokens';
import { AdminAuthService } from './admin-auth.service';
import { renderDashboard, renderLogin } from './views';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

/**
 * Owner analytics dashboard (Phase 8) — internal, password-protected, and
 * read-only: the controller renders server-side HTML and never accepts data
 * from the browser. When ADMIN_PASSWORD is unset every route 404s (disabled).
 */
@Controller('admin')
export class AnalyticsController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService | null,
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
    @Inject(APP_CONFIG_TOKEN) private readonly config: Env,
  ) {}

  @Get()
  async dashboard(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.assertEnabled();
    if (!this.auth!.authenticated(req)) {
      res.redirect('/admin/login');
      return;
    }
    const data = await this.analytics.overview();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderDashboard(data, this.config.BUSINESS_NAME));
  }

  @Get('login')
  loginPage(): string {
    this.assertEnabled();
    return renderLogin();
  }

  @Post('login')
  @UseGuards(new RateLimitGuard({ limit: 5, windowMs: 15 * 60_000 }))
  login(@Body() body: { password?: string }, @Res() res: Response): void {
    this.assertEnabled();
    if (this.auth!.verifyPassword(body?.password)) {
      const cookie = this.auth!.createSession();
      res.setHeader(
        'Set-Cookie',
        `${this.auth!.cookieName}=${cookie}; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=${Math.floor(this.auth!.maxAgeMs / 1000)}${this.secure ? '; Secure' : ''}`,
      );
      res.redirect('/admin');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLogin('Incorrect password'));
  }

  @Post('logout')
  logout(@Res() res: Response): void {
    res.setHeader(
      'Set-Cookie',
      `${this.auth?.cookieName ?? 'wabiz_admin'}=; HttpOnly; Path=/admin; SameSite=Lax; Max-Age=0${this.secure ? '; Secure' : ''}`,
    );
    res.redirect('/admin/login');
  }

  private get secure(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  private assertEnabled(): void {
    if (!this.auth) throw new NotFoundException('Dashboard disabled (ADMIN_PASSWORD not set)');
  }
}