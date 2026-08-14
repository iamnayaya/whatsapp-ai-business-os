-- Phase 7 - payment + delivery integration.
-- 1. Orders: payment lifecycle (paidAt, confirmationSentAt) and manual
--    delivery tracking (deliveryStatus PROCESSING -> SHIPPED -> DELIVERED,
--    trackingReference assigned when the customer pays).
-- 2. Follow-ups: a follow-up is now either abandoned-CART or abandoned-PAYMENT;
--    the unique claim becomes [conversationId, type, attempt].

ALTER TABLE "orders" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN "deliveryStatus" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "orders" ADD COLUMN "trackingReference" TEXT;
ALTER TABLE "orders" ADD COLUMN "confirmationSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "orders_trackingReference_key" ON "orders"("trackingReference");

ALTER TABLE "follow_ups" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'CART';
DROP INDEX "follow_ups_conversationId_attempt_key";
CREATE UNIQUE INDEX "follow_ups_conversationId_type_attempt_key" ON "follow_ups"("conversationId", "type", "attempt");