import type {
  ConversionRate,
  EscalationSummary,
  PeakHour,
  RecoveryRate,
  RecentConversation,
  SalesBucket,
  TopProduct,
} from './types';

/** Coerces a raw $queryRaw cell (numeric | Decimal | string | number) to a
 * safe JS number, defaulting to 0. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export interface SalesRow {
  todayRevenue: unknown;
  todayOrders: number;
  weekRevenue: unknown;
  weekOrders: number;
  monthRevenue: unknown;
  monthOrders: number;
}

export function salesBuckets(row: SalesRow): SalesBucket[] {
  return [
    { label: 'today', revenue: toNumber(row.todayRevenue), orders: toNumber(row.todayOrders) },
    { label: 'week', revenue: toNumber(row.weekRevenue), orders: toNumber(row.weekOrders) },
    { label: 'month', revenue: toNumber(row.monthRevenue), orders: toNumber(row.monthOrders) },
  ];
}

export function conversionRate(chatted: number, converted: number): number {
  if (!chatted || chatted <= 0) return 0;
  return Math.min(1, converted / chatted);
}

export function recoveryRates(rows: Array<{ type: string; sent: number; recovered: number }>): RecoveryRate[] {
  const per: RecoveryRate[] = rows.map((r) => ({
    type: r.type as RecoveryRate['type'],
    sent: toNumber(r.sent),
    recovered: toNumber(r.recovered),
    rate: toNumber(r.sent) > 0 ? toNumber(r.recovered) / toNumber(r.sent) : 0,
  }));
  const sent = per.reduce((s, r) => s + r.sent, 0);
  const recovered = per.reduce((s, r) => s + r.recovered, 0);
  return [...per, { type: 'OVERALL', sent, recovered, rate: sent > 0 ? recovered / sent : 0 }];
}

export interface EscalationRow {
  total: number;
  open: number;
  resolved: number;
  angry: number;
  refundRequests: number;
}

export function escalationSummary(
  row: EscalationRow,
  byCategory: Array<{ category: string; n: number }>,
): EscalationSummary {
  const categories: Record<string, number> = {};
  for (const c of byCategory ?? []) categories[c.category] = toNumber(c.n);
  return {
    total: toNumber(row?.total),
    open: toNumber(row?.open),
    resolved: toNumber(row?.resolved),
    angry: toNumber(row?.angry),
    refundRequests: toNumber(row?.refundRequests),
    byCategory: categories,
  };
}

export interface RecentConversationRow {
  conversationId: string;
  customerId: string;
  name: string | null;
  waId: string;
  lastInbound: string | null;
  lastMessageAt: Date | null;
  sentiment: string | null;
}

const SENTIMENTS = new Set(['POSITIVE', 'NEUTRAL', 'FRUSTRATED']);

export function recentConversations(rows: RecentConversationRow[]): RecentConversation[] {
  return (rows ?? []).map((r) => ({
    conversationId: r.conversationId,
    customerId: r.customerId,
    name: r.name,
    waId: r.waId,
    lastInbound: r.lastInbound ?? null,
    lastMessageAt: r.lastMessageAt instanceof Date ? r.lastMessageAt : null,
    sentiment: r.sentiment && SENTIMENTS.has(r.sentiment) ? (r.sentiment as RecentConversation['sentiment']) : null,
  }));
}

export function toTopProducts(rows: Array<{ productId: string; name: string; quantity: unknown; revenue: unknown }>): TopProduct[] {
  return (rows ?? []).map((r) => ({
    productId: r.productId,
    name: r.name ?? 'Unknown',
    quantity: toNumber(r.quantity),
    revenue: toNumber(r.revenue),
  }));
}

export function toPeakHours(rows: Array<{ hour: unknown; n: number }>): PeakHour[] {
  return (rows ?? []).map((r) => ({ hour: toNumber(r.hour), count: toNumber(r.n) }));
}

export function toConversion(row: { chatted: number; converted: number }): ConversionRate {
  return {
    chatted: toNumber(row?.chatted),
    converted: toNumber(row?.converted),
    rate: conversionRate(toNumber(row?.chatted), toNumber(row?.converted)),
  };
}