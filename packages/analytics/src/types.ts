/** Read-only dashboard data (Phase 8). All money values are the business
 * currency (NGN) as plain numbers. Rates are decimal fractions in [0, 1]. */

export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'FRUSTRATED';

export interface SalesBucket {
  label: 'today' | 'week' | 'month';
  revenue: number;
  orders: number;
}

export interface TopProduct {
  productId: string;
  name: string;
  quantity: number;
  revenue: number;
}

export interface PeakHour {
  /** Hour of day (0–23) in the business timezone. */
  hour: number;
  count: number;
}

export interface ConversionRate {
  /** Distinct customers who started a conversation in the period. */
  chatted: number;
  /** Of those, how many placed a paid order in the period. */
  converted: number;
  /** converted / chatted (0 when there are no chatted customers). */
  rate: number;
}

export interface RecoveryRate {
  /** CART, PAYMENT, or OVERALL. */
  type: 'CART' | 'PAYMENT' | 'OVERALL';
  sent: number;
  recovered: number;
  /** recovered / sent (0 when nothing was sent). */
  rate: number;
}

export interface EscalationSummary {
  total: number;
  open: number;
  resolved: number;
  angry: number;
  refundRequests: number;
  byCategory: Record<string, number>;
}

export interface RecentConversation {
  conversationId: string;
  customerId: string;
  name: string | null;
  waId: string;
  /** The customer's latest inbound text (context for the sentiment). */
  lastInbound: string | null;
  lastMessageAt: Date | null;
  /** The AI agent's own assessment from the latest agent turn (if any). */
  sentiment: SentimentLabel | null;
}

export interface DashboardData {
  generatedAt: Date;
  sales: SalesBucket[];
  topProducts: TopProduct[];
  peakHours: PeakHour[];
  conversion: ConversionRate;
  recovery: RecoveryRate[];
  escalations: EscalationSummary;
  recentConversations: RecentConversation[];
}