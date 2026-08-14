import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AnalyticsController } from '../src/analytics/analytics.controller';
import { AdminAuthService } from '../src/analytics/admin-auth.service';
import type { AnalyticsService } from '../../../packages/analytics/src';
import type { DashboardData } from '../../../packages/analytics/src';
import type { Env } from '../../../packages/shared/src';

const dashboardData: DashboardData = {
  generatedAt: new Date('2026-08-14T12:00:00Z'),
  sales: [
    { label: 'today', revenue: 125000, orders: 2 },
    { label: 'week', revenue: 410000, orders: 7 },
    { label: 'month', revenue: 1200000, orders: 22 },
  ],
  topProducts: [{ productId: 'p1', name: 'Rice 50kg', quantity: 12, revenue: 1020000 }],
  peakHours: [{ hour: 10, count: 8 }],
  conversion: { chatted: 30, converted: 9, rate: 0.3 },
  recovery: [{ type: 'CART', sent: 10, recovered: 4, rate: 0.4 }, { type: 'OVERALL', sent: 10, recovered: 4, rate: 0.4 }],
  escalations: { total: 5, open: 2, resolved: 3, angry: 2, refundRequests: 1, byCategory: { ANGRY_CUSTOMER: 2 } },
  recentConversations: [
    { conversationId: 'c1', customerId: 'cust-1', name: 'Amina', waId: '2348', lastInbound: 'Hello', lastMessageAt: new Date(), sentiment: 'POSITIVE' },
    { conversationId: 'c2', customerId: 'cust-2', name: 'Yusuf', waId: '2349', lastInbound: 'Refund me', lastMessageAt: new Date(), sentiment: 'FRUSTRATED' },
  ],
};

function makeAuth(): AdminAuthService {
  return new AdminAuthService({ password: 'pw', sessionSecret: 'secret', cookieName: 'wabiz_admin', maxAgeMs: 1000 });
}

function fakeRes() {
  const res: Record<string, unknown> & { headers: Record<string, string>; redirected?: string; body?: string } = { headers: {} };
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

function makeController(overrides: { auth?: AdminAuthService | null; overview?: ReturnType<typeof vi.fn> } = {}) {
  const auth = overrides.auth === undefined ? makeAuth() : overrides.auth;
  const analytics = { overview: overrides.overview ?? vi.fn().mockResolvedValue(dashboardData) } as unknown as AnalyticsService;
  const config = { BUSINESS_NAME: 'Test Shop' } as Env;
  const controller = new AnalyticsController(auth, analytics, config);
  return { controller, analytics };
}

describe('AnalyticsController (dashboard routes)', () => {
  it('404s every route when the dashboard is disabled (no ADMIN_PASSWORD)', async () => {
    const { controller } = makeController({ auth: null });
    const res = fakeRes();
    await expect(controller.dashboard(fakeReq(), res as never)).rejects.toThrow(NotFoundException);
    expect(() => controller.loginPage()).toThrow(NotFoundException);
  });

  it('redirects an unauthenticated browser to the login page without touching the DB', async () => {
    const { controller, analytics } = makeController();
    const res = fakeRes();
    await controller.dashboard(fakeReq(), res as never);
    expect(res.redirected).toBe('/admin/login');
    expect(analytics.overview).not.toHaveBeenCalled();
  });

  it('renders the dashboard HTML with the data once authenticated', async () => {
    const { controller, analytics } = makeController();
    const auth = makeAuth();
    const session = auth.createSession(Date.now());
    const res = fakeRes();
    await controller.dashboard(fakeReq(`wabiz_admin=${session}`), res as never);
    expect(analytics.overview).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('Owner Dashboard');
    expect(res.body).toContain('₦125,000');
    expect(res.body).toContain('Rice 50kg');
    expect(res.body).toContain('chip positive">Positive');
    expect(res.body).toContain('chip frustrated">Frustrated');
    expect(res.body).toContain('NAYAYA'); // brand logo lockup in the header
    expect(res.body).toContain('data:image/svg+xml'); // favicon data URI
  });

  it('rejects a wrong password and renders the login page with an error', () => {
    const { controller } = makeController();
    const res = fakeRes();
    controller.login({ password: 'nope' }, res as never);
    expect(res.body).toContain('Incorrect password');
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('issues a signed session cookie and redirects on a correct password', () => {
    const { controller } = makeController();
    const res = fakeRes();
    controller.login({ password: 'pw' }, res as never);
    expect(res.redirected).toBe('/admin');
    expect(res.headers['Set-Cookie']).toMatch(/^wabiz_admin=[^;]+; HttpOnly; Path=\/admin/);
  });
});