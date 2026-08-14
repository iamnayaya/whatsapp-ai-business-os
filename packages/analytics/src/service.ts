import { Prisma, type PrismaClient } from '../../db/src';
import {
  escalationSummary,
  recentConversations,
  recoveryRates,
  salesBuckets,
  toConversion,
  toNumber,
  toPeakHours,
  toTopProducts,
  type EscalationRow,
  type RecentConversationRow,
  type SalesRow,
} from './assemble';
import type { DashboardData } from './types';

export interface AnalyticsServiceDeps {
  prisma: PrismaClient;
  /** IANA timezone the business runs in (e.g. Africa/Lagos) — used to bucket
   * "today / this week / this month" and peak hours on the owner's clock. */
  timeZone?: string;
  /** Single-business system: pass the id to skip resolution (or let overview
   * resolve the first business). */
  businessId?: string;
}

const PAID_ORDER_STATUSES = `('PAID','FULFILLING','FULFILLED')`;

/**
 * Phase 8 — read-only analytics over the production database. This service
 * issues ONLY SELECT queries (Prisma `$queryRaw` / `findFirst`); there is no
 * write path here, and when `ANALYTICS_DATABASE_URL` is configured the module
 * points it at a SELECT-only role/replica so even a bug cannot corrupt data.
 */
export class AnalyticsService {
  private readonly prisma: PrismaClient;
  private readonly timeZone: string;
  private readonly businessId?: string;

  constructor(deps: AnalyticsServiceDeps) {
    this.prisma = deps.prisma;
    this.timeZone = deps.timeZone ?? 'Africa/Lagos';
    this.businessId = deps.businessId;
  }

  /**
   * Builds a boundary in the business timezone as a timestamptz: local start
   * of day / week (Monday) / month. `nowMs` is an epoch-ms instant; it is
   * converted via to_timestamp so the semantics never depend on the session
   * timezone.
   */
  private boundary(unit: 'day' | 'week' | 'month', nowMs: number): Prisma.Sql {
    return Prisma.sql`(date_trunc(${unit}, (to_timestamp(${nowMs / 1000.0}) AT TIME ZONE ${this.timeZone}::text)) AT TIME ZONE ${this.timeZone}::text)`;
  }

  private async resolveBusinessId(): Promise<string | undefined> {
    if (this.businessId) return this.businessId;
    const business = await this.prisma.business.findFirst({ select: { id: true } });
    return business?.id;
  }

  /** Revenue + order counts for paid orders bucketed today / this week / this month. */
  async sales(nowMs = Date.now()): Promise<SalesRow> {
    const rows = await this.prisma.$queryRaw<SalesRow[]>`
      SELECT
        COALESCE(SUM("total") FILTER (WHERE "paidAt" >= ${this.boundary('day', nowMs)}), 0) AS "todayRevenue",
        COUNT(*) FILTER (WHERE "paidAt" >= ${this.boundary('day', nowMs)}) AS "todayOrders",
        COALESCE(SUM("total") FILTER (WHERE "paidAt" >= ${this.boundary('week', nowMs)}), 0) AS "weekRevenue",
        COUNT(*) FILTER (WHERE "paidAt" >= ${this.boundary('week', nowMs)}) AS "weekOrders",
        COALESCE(SUM("total") FILTER (WHERE "paidAt" >= ${this.boundary('month', nowMs)}), 0) AS "monthRevenue",
        COUNT(*) FILTER (WHERE "paidAt" >= ${this.boundary('month', nowMs)}) AS "monthOrders"
      FROM "orders"
      WHERE "businessId" = ${await this.resolveBusinessId()}
        AND "status" IN ${Prisma.raw(PAID_ORDER_STATUSES)}
        AND "paidAt" IS NOT NULL
    `;
    return rows[0] ?? emptySalesRow();
  }

  /** Top-selling products by units moved (paid orders only). */
  async topProducts(limit = 5): Promise<Array<{ productId: string; name: string; quantity: unknown; revenue: unknown }>> {
    return this.prisma.$queryRaw`
      SELECT oi."productId", COALESCE(p.name, 'Unknown') AS name,
             SUM(oi."quantity")::int AS quantity,
             SUM(oi."total") AS revenue
      FROM "order_items" oi
      JOIN "orders" o ON o.id = oi."orderId"
      LEFT JOIN "products" p ON p.id = oi."productId"
      WHERE o."businessId" = ${await this.resolveBusinessId()}
        AND o."status" IN ${Prisma.raw(PAID_ORDER_STATUSES)}
      GROUP BY oi."productId", p.name
      ORDER BY quantity DESC
      LIMIT ${limit}
    `;
  }

  /** Peak inbound-message hours (business timezone) over the last 30 days. */
  async peakHours(nowMs = Date.now()): Promise<Array<{ hour: unknown; n: number }>> {
    const sinceMs = nowMs - 30 * 24 * 60 * 60 * 1000;
    return this.prisma.$queryRaw`
      SELECT EXTRACT(HOUR FROM (m."sentAt" AT TIME ZONE ${this.timeZone}::text))::int AS hour,
             COUNT(*) AS n
      FROM "messages" m
      JOIN "conversations" c ON c.id = m."conversationId"
      WHERE c."businessId" = ${await this.resolveBusinessId()}
        AND m."direction" = 'INBOUND'
        AND m."sentAt" >= to_timestamp(${sinceMs / 1000.0})
      GROUP BY 1
      ORDER BY n DESC
      LIMIT 6
    `;
  }

  /** This month: distinct customers who chatted vs. who placed a paid order. */
  async conversion(nowMs = Date.now()): Promise<{ chatted: number; converted: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ chatted: number; converted: number }>>`
      SELECT
        COUNT(DISTINCT c."customerId") AS chatted,
        COUNT(DISTINCT o."customerId") AS converted
      FROM "conversations" c
      LEFT JOIN "orders" o
        ON o."customerId" = c."customerId"
       AND o."businessId" = ${await this.resolveBusinessId()}
       AND o."status" IN ${Prisma.raw(PAID_ORDER_STATUSES)}
       AND o."createdAt" >= ${this.boundary('month', nowMs)}
      WHERE c."businessId" = ${await this.resolveBusinessId()}
        AND c."createdAt" >= ${this.boundary('month', nowMs)}
    `;
    return rows[0] ?? { chatted: 0, converted: 0 };
  }

  /** Abandoned-cart / abandoned-payment recovery from the Phase 5 follow-up
   * engine: SENT nudges that later produced an order. */
  async recovery(): Promise<Array<{ type: string; sent: number; recovered: number }>> {
    return this.prisma.$queryRaw`
      SELECT "type",
             COUNT(*) AS sent,
             COUNT(*) FILTER (WHERE "ledToOrder") AS recovered
      FROM "follow_ups"
      WHERE "businessId" = ${await this.resolveBusinessId()}
        AND "status" = 'SENT'
      GROUP BY "type"
    `;
  }

  /** Escalation / complaint volume this month (Phase 6). */
  async escalations(nowMs = Date.now()): Promise<{ summary: EscalationRow; byCategory: Array<{ category: string; n: number }> }> {
    const rows = await this.prisma.$queryRaw<EscalationRow[]>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE "status" = 'OPEN') AS open,
        COUNT(*) FILTER (WHERE "status" = 'RESOLVED') AS resolved,
        COUNT(*) FILTER (WHERE "category" = 'ANGRY_CUSTOMER') AS angry,
        COUNT(*) FILTER (WHERE "category" = 'REFUND_REQUEST') AS "refundRequests"
      FROM "escalations"
      WHERE "businessId" = ${await this.resolveBusinessId()}
        AND "createdAt" >= ${this.boundary('month', nowMs)}
    `;
    const byCategory = await this.prisma.$queryRaw<Array<{ category: string; n: number }>>`
      SELECT "category", COUNT(*) AS n
      FROM "escalations"
      WHERE "businessId" = ${await this.resolveBusinessId()}
        AND "createdAt" >= ${this.boundary('month', nowMs)}
      GROUP BY "category"
      ORDER BY n DESC
    `;
    return { summary: rows[0] ?? emptyEscalationRow(), byCategory };
  }

  /** The 10 most recent conversations, with the agent's own sentiment on the
   * latest agent turn (POSITIVE / NEUTRAL / FRUSTRATED). */
  async recentConversations(limit = 10): Promise<RecentConversationRow[]> {
    return this.prisma.$queryRaw`
      SELECT c.id AS "conversationId",
             c."customerId",
             cu.name,
             cu."waId",
             last.text AS "lastInbound",
             last."sentAt" AS "lastMessageAt",
             sent.sentiment
      FROM "conversations" c
      JOIN "customers" cu ON cu.id = c."customerId"
      LEFT JOIN LATERAL (
        SELECT m.text, m."sentAt"
        FROM "messages" m
        WHERE m."conversationId" = c.id AND m."direction" = 'INBOUND'
        ORDER BY m."sentAt" DESC
        LIMIT 1
      ) last ON true
      LEFT JOIN LATERAL (
        SELECT m.sentiment, m."sentAt"
        FROM "messages" m
        WHERE m."conversationId" = c.id
          AND m."direction" = 'OUTBOUND'
          AND m.sentiment IS NOT NULL
        ORDER BY m."sentAt" DESC
        LIMIT 1
      ) sent ON true
      WHERE c."businessId" = ${await this.resolveBusinessId()}
      ORDER BY COALESCE(c."lastMessageAt", c."createdAt") DESC
      LIMIT ${limit}
    `;
  }

  /** Everything the dashboard shows, in one read-only pass. */
  async overview(nowMs = Date.now()): Promise<DashboardData> {
    const businessId = await this.resolveBusinessId();
    if (!businessId) return emptyOverview(new Date(nowMs));

    const [sales, top, hours, conv, rec, esc, recent] = await Promise.all([
      this.sales(nowMs),
      this.topProducts(),
      this.peakHours(nowMs),
      this.conversion(nowMs),
      this.recovery(),
      this.escalations(nowMs),
      this.recentConversations(),
    ]);

    const escSummary = escalationSummary(esc.summary, esc.byCategory);

    return {
      generatedAt: new Date(nowMs),
      sales: salesBuckets(sales),
      topProducts: toTopProducts(top),
      peakHours: toPeakHours(hours),
      conversion: toConversion(conv),
      recovery: recoveryRates(rec),
      escalations: escSummary,
      recentConversations: recentConversations(recent),
    };
  }
}

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  return new AnalyticsService(deps);
}

function emptySalesRow(): SalesRow {
  return {
    todayRevenue: 0,
    todayOrders: 0,
    weekRevenue: 0,
    weekOrders: 0,
    monthRevenue: 0,
    monthOrders: 0,
  };
}

function emptyEscalationRow(): EscalationRow {
  return { total: 0, open: 0, resolved: 0, angry: 0, refundRequests: 0 };
}

function emptyOverview(now: Date): DashboardData {
  return {
    generatedAt: now,
    sales: [
      { label: 'today', revenue: 0, orders: 0 },
      { label: 'week', revenue: 0, orders: 0 },
      { label: 'month', revenue: 0, orders: 0 },
    ],
    topProducts: [],
    peakHours: [],
    conversion: { chatted: 0, converted: 0, rate: 0 },
    recovery: [{ type: 'OVERALL', sent: 0, recovered: 0, rate: 0 }],
    escalations: { total: 0, open: 0, resolved: 0, angry: 0, refundRequests: 0, byCategory: {} },
    recentConversations: [],
  };
}

export { toNumber };