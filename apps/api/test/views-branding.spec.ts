import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderLogin, renderDashboard } from '../src/analytics/views';
import type { DashboardData } from '../../../packages/analytics/src';
import { brand } from '../../../packages/shared/src';

const VIEWS_PATH = join(__dirname, '..', 'src', 'analytics', 'views.ts');

function sampleData(): DashboardData {
  return {
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    sales: [{ label: 'today', revenue: 125000, orders: 2 }],
    topProducts: [{ productId: 'p-1', name: 'Rice 50kg', quantity: 3, revenue: 255000 }],
    peakHours: [{ hour: 12, count: 5 }],
    conversion: { chatted: 10, converted: 2, rate: 0.2 },
    recovery: [
      { type: 'OVERALL', sent: 4, recovered: 1, rate: 0.25 },
      { type: 'CART', sent: 2, recovered: 1, rate: 0.5 },
      { type: 'PAYMENT', sent: 2, recovered: 0, rate: 0 },
    ],
    escalations: {
      total: 1,
      open: 1,
      resolved: 0,
      angry: 0,
      refundRequests: 0,
      byCategory: { angry_customer: 0 },
    },
    recentConversations: [
      {
        conversationId: 'conv-1',
        customerId: 'cust-1',
        name: 'Aisha',
        waId: '2348012345678',
        lastInbound: 'Price?',
        lastMessageAt: new Date(),
        sentiment: 'NEUTRAL',
      },
    ],
  };
}

describe('dashboard branding (requirement: no hex outside the theme file)', () => {
  it('views.ts contains no hardcoded hex literals', () => {
    const source = readFileSync(VIEWS_PATH, 'utf8');
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('views.ts styles reference brand CSS custom properties only', () => {
    const source = readFileSync(VIEWS_PATH, 'utf8');
    expect(source).toMatch(/var\(--brand-primary\)/);
    expect(source).toMatch(/var\(--brand-base\)/);
    expect(source).toMatch(/var\(--brand-serif\)/);
    expect(source).toMatch(/var\(--brand-sans\)/);
  });

  it('renders the brand logo + favicon in both pages', () => {
    const login = renderLogin();
    const dash = renderDashboard(sampleData(), 'Test Shop');
    for (const html of [login, dash]) {
      expect(html).toContain('/assets/nayaya-logo.png');
      expect(html).toContain('data:image/svg+xml');
      expect(html).toContain(brand.fonts.googleStylesheet);
    }
  });

  it('uses Terracotta primary buttons and Warm Ivory backgrounds via tokens', () => {
    const dash = renderDashboard(sampleData(), 'Test Shop');
    expect(dash).toContain('--brand-primary: #B55A3A;');
    expect(dash).toContain('--brand-base: #F5EFE6;');
    expect(dash).toContain('background: var(--brand-primary)'); // login button
    expect(dash).toContain('background: var(--brand-base)'); // page body
  });
});