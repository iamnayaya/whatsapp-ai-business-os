-- Phase 6 — multi-agent orchestration.
-- 1. Delivery address on orders (used by the logistics agent).
-- 2. Escalation queue: one row per hand-off to a human operator.

ALTER TABLE "orders" ADD COLUMN "deliveryAddress" TEXT;

CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OTHER',
    "sourceAgent" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "escalations_businessId_status_idx" ON "escalations"("businessId", "status");
CREATE INDEX "escalations_conversationId_status_idx" ON "escalations"("conversationId", "status");
CREATE INDEX "escalations_category_idx" ON "escalations"("category");

ALTER TABLE "escalations"
    ADD CONSTRAINT "escalations_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "escalations"
    ADD CONSTRAINT "escalations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "escalations"
    ADD CONSTRAINT "escalations_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;