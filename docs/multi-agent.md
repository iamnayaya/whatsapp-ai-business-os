# Phase 6 — Multi-Agent Orchestration

A single WhatsApp conversation is served by three **specialized agents** —
`sales`, `support`, `logistics` — but the customer always sees **one**
assistant. Every message is routed to the right agent, and all agents share the
same conversation history and the same tool registry, so there is no duplicated
logic and no "multiple personalities".

## Architecture

```
                ┌───────────────────────────────────────────────┐
 customer msg   │ packages/ai                                   │
 ─────────────► │  AgentOrchestrator.run(input)                  │
                │   │                                            │
                │   ├─ router.route({text, history})            │
                │   │    • keyword heuristic (deterministic)     │
                │   │    • LLM fallback when nothing matches     │
                │   ▼                                            │
                │   sales / support / logistics  (Agent subclasses)
                │        │   └─ ONE shared TOOLS registry        │
                │        └─ ONE shared history (AgentRunInput)   │
                │   │                                            │
                │   └─ if escalated → write `escalations` row    │
                └───────────────────────────────────────────────┘
```

### Routing (`packages/ai/src/router.ts`)

`MessageRouter` is deliberately lightweight:

1. **Keyword scoring** (`classifyHeuristic`) — word/phrase lists per agent.
   Support and logistics matches count **double** against sales, because
   problem/delivery words ("refund", "damaged", "delivery") are far more
   diagnostic than generic buying words ("i want", "order", "bag") that appear
   in nearly every thread. Ties resolve support > logistics > sales.
2. **LLM fallback** — only when *nothing* matches heuristically ("ok", "thanks",
   "👍"). The classifier asks Gemini for strict JSON `{"agent": "…"}`; any
   failure defaults to `sales`. Configure it by passing an `llm` to
   `new MessageRouter({ llm })` (the orchestrator does this by default; tests
   pass a heuristic-only router so the scripted LLM is never consumed by
   routing).

Routing input is the current user message: a clear voice-note transcription if
present, else the last user turn.

### Agents (`packages/ai/src/agent.ts`)

The Phase 2 `SalesAgent` was refactored into a generic `Agent` base class
parameterized by `role`; `SalesAgent`, `SupportAgent`, `LogisticsAgent` are thin
subclasses. Each builds its system prompt with `buildAgentPrompt`
(`prompt.ts`): a **shared brand voice** (tone, grounding, pricing, escalation
rules, voice-note handling — identical for every role) plus a short
role-specific "Your focus" section. The customer never sees the seam: prompts
explicitly forbid mentioning "agents", "teams", or "handing off".

### Shared tools (`packages/ai/src/tools.ts`)

All three agents execute the **same** `TOOLS` registry — the support agent can
read order data with `get_order_status`, the logistics agent changes addresses
with `update_order_address`. No per-agent copies of tool logic. Phase 6 adds:

- `update_order_address` — new delivery address for an order; rejected once the
  order is `FULFILLED`/`CANCELLED`/`REFUNDED`. Audits `DELIVERY_ADDRESS_UPDATED`.
- `escalate_to_human` — now takes an optional `category`
  (`angry_customer` / `refund_request` / `agent_uncertain` / `out_of_scope`).
- `get_order_status` — now also returns `deliveryAddress`, `fulfilledAt`, `notes`.

### Escalation queue (`packages/ai/src/orchestrator.ts` + `escalations` table)

When an agent calls `escalate_to_human`, the orchestrator writes a row to the
new `escalations` table — a **reviewable queue** for human staff — with:

- `reason` (verbatim from the tool) and `category` (the model-passed value,
  normalized, else a heuristic fallback from the reason text)
- `sourceAgent` (which specialist escalated) and `status` (`OPEN` → `RESOLVED`)
- Audit `ESCALATION_CREATED` alongside the existing conversation-level
  `ESCALATED_TO_HUMAN`.

**Idempotency:** at most one `OPEN` escalation per conversation, so a BullMQ
retry after a failed WhatsApp send never creates duplicate hand-offs.

### Support policy

The support agent's prompt includes the refund threshold
(`REFUND_ESCALATION_THRESHOLD`, default ₦50,000): requests above it are always
escalated, never self-approved.

## Worker wiring

`apps/worker/src/main.ts` replaces `SalesAgent` with `AgentOrchestrator`
(the handler keeps calling `agent.run(...)` — `OrchestratorReply` is an
`AgentReply` plus `routedTo`). The handler records `routedTo` on the outbound
message and audits.

## Schema changes (migration `20260815000000_multi_agent`)

- `Order.deliveryAddress TEXT?`
- `Escalation` — `id, businessId, customerId, conversationId, reason, category,
  sourceAgent, status, resolvedAt, createdAt` (+ indexes on status/category)

## Tests

- `packages/ai/test/router.spec.ts` — heuristic scoring, tie-breaks, LLM
  fallback, default-to-sales.
- `packages/ai/test/orchestrator.spec.ts` — dispatch, shared history, escalation
  writes (category from model vs. from reason), idempotency, `routingText`.
- `packages/ai/test/mixed-conversations.spec.ts` — **5 mixed conversations**
  (buy → damage → refund, delivery → address change → return, price → delivery
  timing, angry → human, wrong item → price) each routing **mid-conversation**
  between agents over one history. Asserts `routedTo`, the role prompt that ran,
  and the persisted escalation rows.
- `tests/integration/multi-agent.integration.spec.ts` — the same 5 conversations
  against real Postgres (Testcontainers), asserting real side effects: an order
  created from the cart, `deliveryAddress` updated, and `escalations` rows.
  Run with `npm run test:integration` (requires Docker).