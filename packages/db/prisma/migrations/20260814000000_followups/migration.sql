-- CreateTable
CREATE TABLE "follow_ups" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "messageText" TEXT NOT NULL,
    "waMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "ledToOrder" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "follow_ups_conversationId_attempt_key" ON "follow_ups"("conversationId", "attempt");

-- CreateIndex
CREATE INDEX "follow_ups_businessId_createdAt_idx" ON "follow_ups"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "follow_ups_customerId_idx" ON "follow_ups"("customerId");

-- CreateIndex
CREATE INDEX "follow_ups_status_idx" ON "follow_ups"("status");

-- CreateIndex
CREATE INDEX "follow_ups_ledToOrder_idx" ON "follow_ups"("ledToOrder");

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
