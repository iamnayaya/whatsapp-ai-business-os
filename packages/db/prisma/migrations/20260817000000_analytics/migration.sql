-- Phase 8 — Owner Analytics Dashboard
-- The AI agent's own sentiment assessment for a turn (POSITIVE | NEUTRAL |
-- FRUSTRATED), computed during the conversation (no separate analysis pass).
ALTER TABLE "messages" ADD COLUMN "sentiment" TEXT;