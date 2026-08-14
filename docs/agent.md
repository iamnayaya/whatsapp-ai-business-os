# Module: AI Sales Agent (Phase 2)

The conversational layer that actually sells. It sits inside the Phase 1
worker: every inbound **text** message (including interactive button/list
replies, whose answer is stored as text) runs through a Gemini Flash agent
that browses the catalog, answers questions, and creates draft orders — then
the reply is sent back over WhatsApp.

## What it does

1. **Gemini client** (`packages/ai/src/client.ts`) — thin wrapper around
   `@google/generative-ai` with the shared retry policy (5 attempts,
   exponential backoff). Retries on 429/5xx/network; fails fast on 4xx/auth.
   Model is configurable via `GEMINI_MODEL` (default `gemini-flash-latest`).
2. **Agent loop** (`packages/ai/src/agent.ts`) — feeds the conversation
   history + system prompt to the model with function calling enabled:
   - If the model returns text → that's the reply.
   - If the model calls tools → handlers execute against Postgres, results
     are returned as `functionResponse`, and the loop continues.
   - The loop is capped at 6 rounds so a stuck model can never spin forever.
3. **Tools** (`packages/ai/src/tools.ts`) — everything the agent can do:
   - `search_products(query?)` — catalog search, includes live stock.
   - `get_product(id)` — full details for one product.
   - `create_order(items, note?)` — creates a **DRAFT** order with line
     items + totals in a transaction. Validates products exist and stock is
     sufficient. Business failures (unknown product / low stock) are fed back
     to the model as `ok:false` so it can adjust the order with the customer.
   - `get_order_status(order_id)` — order + payment status for this customer.
   - `escalate_to_human(reason)` — hand off to a human (Phase 5 delivers the
     actual staff channel; Phase 2 marks the conversation `ESCALATED`).
4. **Escalation** — when the customer asks for a human or the agent is not
   confident, it calls `escalate_to_human`. The worker then:
   - sets the conversation status to `ESCALATED`,
   - writes an `ESCALATED_TO_HUMAN` audit row,
   - sends the handoff message.
5. **Audit** — every money/stock action is written to `agent_actions`:
   `ORDER_CREATED` (from `create_order`), `MESSAGE_SENT` (worker), and
   `ESCALATED_TO_HUMAN`. Actor is always `AI_AGENT`.

## What it does NOT do yet

- **No image/document understanding.** Images and documents are ingested but
  not answered (Phase 3 handles voice; image understanding is a later phase).
- **No payment.** Orders are created as `DRAFT` and confirmed by chat.
  Payment links/confirmation arrive in Phase 7 (Paystack).
- **No staff channel.** Escalation marks the conversation; a human dashboard/
  notification is Phase 5.

## Conversation context

The agent sees the last 10 messages of the conversation (inbound → `user`,
outbound → `model`). Media-only messages become short placeholders
(`[Voice note]`, `[Image]`, …) so the model still knows something arrived —
voice notes are transcribed first (Phase 3, see [docs/voice.md](voice.md)) and
the transcription is fed in as the user text.
The system prompt enforces WhatsApp-style short replies, honest prices (no
invented products), confirmation-before-order, and escalation triggers.

## How to try it locally

Requires Phase 1 running (Postgres + Redis + `.env`), plus:

```bash
# 1. Get a free Gemini API key: https://aistudio.google.com/apikey
#    Add to .env:
#    GEMINI_API_KEY=...
#    GEMINI_MODEL=gemini-flash-latest

# 2. Load the sample catalog (idempotent — safe to re-run)
npm run db:seed

# 3. Start API + worker (two terminals)
npm run dev:api
npm run dev:worker

# 4. Tunnel with ngrok, point the Meta webhook at it, and message your number:
#    "What do you sell?"
#    "How much is the 50kg rice?"
#    "I want 2 bags of rice and a 5L palm oil"
#    The agent confirms, creates the order, and replies with the total + order id.
```

## Testing

```bash
npm test
```

- `packages/ai/test/tools.spec.ts` — every tool against a fake Prisma:
  search/filter/stock, product detail, order creation + totals + audit,
  stock rejection, order status, escalation.
- `packages/ai/test/agent.spec.ts` — the loop with a fake LLM (no network):
  plain text reply, tool call → final reply, escalation flagging, tool-loop
  cap, unknown-tool resilience, and `buildContents` history shaping.
- `apps/worker/test/handler.spec.ts` — media-only (agent skipped), text
  (agent runs, outbound stored + sent + audited), escalation behavior, and
  the FAILED/retry contract.

## Cost

Gemini Flash is priced at fractions of a cent per thousand tokens; at your
volume (100–500 orders/mo) the agent typically costs **single-digit dollars
per month**.
