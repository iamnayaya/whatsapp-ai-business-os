# Phase 5 — Follow-up / Abandoned-Cart Engine

When a customer adds items to their cart but stops replying, the engine sends
a gentle, **item-specific** WhatsApp nudge — never a generic "are you still
there?". It runs entirely as a **background BullMQ repeatable (cron) job**, so
the webhook path stays fast. It respects quiet hours in the business's local
timezone, caps at 2 nudges per abandoned cart, and records every send so the
Phase 8 analytics dashboard can measure effectiveness.

## I/O

### Detection

A conversation is an "abandoned cart" candidate when all of these hold:

- `conversations.status = OPEN`
- `conversations.metadata.cart.items` is a non-empty array (the Phase 2 agent
  persists the cart there after any `add_to_cart`)
- It has been quiet for the configured delay since the customer's **last
  inbound message** (the quiet clock is customer activity, not our own sends)

The engine then decides via `decideFollowUp(now, lastActivityAt, sentAttempts)`:

| sentAttempts | delay needed | action |
|---|---|---|
| 0 | `FOLLOWUP_FIRST_DELAY_MINUTES` (default **2h**) | send attempt 1 |
| 1 | `FOLLOWUP_SECOND_DELAY_MINUTES` (default **24h**) | send attempt 2 (final) |
| >= `FOLLOWUP_MAX_ATTEMPTS` (default **2**) | — | **capped** — never send again |

### Message

`buildFollowUpMessage` (`packages/followup/src/message.ts`) names the exact
items and quantities from the cart ("2x Rice 50kg and 1x Palm Oil 5L" +
total). Attempt 1 is a warm nudge ("no pressure at all…"), attempt 2 is
softer and leaves the door open ("No rush at all"). It never promises
delivery or discounts, and never says "are you still there?".

### Quiet hours

`isQuietHour(now, businessTimezone, config)` (`timing.ts`) uses `Intl` to get
the local hour in the **business's** timezone (`businesses.timezone`,
default `Africa/Lagos`). The default window is **21:00 → 09:00 local** and
wraps across midnight. Equal start/end values (e.g. `0` and `0`) disable the
rule. Customer-local timezone isn't stored yet — for a single-country shop the
business timezone is the right proxy (documented assumption).

### Send + record

For each due, non-quiet cart the engine:

1. **Claims** a `follow_ups` row (`status = SENDING`) with
   `@@unique([conversationId, attempt])` **before** sending — a second scan
   that races the first loses the unique constraint instead of double-sending.
2. Sends via `WhatsAppClient.sendText`.
3. Marks the claim `SENT` with the `waMessageId`, stores the message as a real
   `messages` row (`OUTBOUND`, `SENT`), touches `conversations.lastMessageAt`,
   and audits `FOLLOW_UP_SENT`.
4. On send failure: marks the claim `FAILED` and **rethrows** so BullMQ
   retries the scan (the failed attempt still counts toward the cap — honest).

## Queue wiring

`packages/queue/src/index.ts`:

- `FOLLOW_UP_SCAN` queue + `scheduleFollowUpScan({ queue, cron })` registers a
  repeatable job (deduped by name+pattern, safe on every worker boot).
- `createFollowUpScanWorker` runs with **concurrency 1**, so scans are
  serialized and the per-conversation claim is the only guard needed.

Wired in `apps/worker/src/main.ts` — the same worker process now drains the
message queue **and** runs the follow-up scan. It does **not** touch the
webhook request path.

## DB effects

| Table | What gets written |
|---|---|
| `follow_ups` | one row per follow-up attempt: `attempt`, `items`, `messageText`, `waMessageId`, `status` (`SENDING`/`SENT`/`FAILED`), `ledToOrder` |
| `messages` | the follow-up text as a real `OUTBOUND` message (keeps agent history coherent) |
| `conversations` | `lastMessageAt` bumped to the send time |
| `agent_actions` | `FOLLOW_UP_SENT` per send; `ORDER_ATTRIBUTED_TO_FOLLOW_UP` when an order follows |

## Measuring effectiveness

`follow_ups.ledToOrder` starts `false`. When `create_order` succeeds (Phase 2
tool), it flips every `SENT` follow-up for that conversation to `true`
(`packages/ai/src/tools.ts`) and audits `ORDER_ATTRIBUTED_TO_FOLLOW_UP`. The
Phase 8 dashboard can then compute conversion rate = led-to-order / total.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FOLLOWUP_SCAN_CRON` | `0 */15 * * * *` | cron pattern for the scan job |
| `FOLLOWUP_FIRST_DELAY_MINUTES` | `120` | quiet before the 1st nudge |
| `FOLLOWUP_SECOND_DELAY_MINUTES` | `1440` | quiet before the final nudge |
| `FOLLOWUP_QUIET_START` | `21` | quiet window start (local hour) |
| `FOLLOWUP_QUIET_END` | `9` | quiet window end (local hour); equal = disabled |
| `FOLLOWUP_MAX_ATTEMPTS` | `2` | hard cap per abandoned cart |

## Tests

```bash
npx vitest run packages/followup/test/timing.spec.ts    # due logic (mocked clock) + quiet hours
npx vitest run packages/followup/test/message.spec.ts   # item-referencing, non-generic templates
npx vitest run packages/followup/test/engine.spec.ts    # send/record/audit, 2-attempt cap, quiet-hours skip, P2002 race
npx vitest run packages/ai/test/tools.spec.ts           # ledToOrder attribution on create_order
```

The clock is **injected** (`runScan({ now })`, `decideFollowUp(now, …)`) so
timing tests never need fake timers. `isQuietHour` uses fixed instants against
`Africa/Lagos` (UTC+1, no DST) for deterministic assertions.

## Status

Phase 5 complete ✅. Next: Phase 6 (multi-agent orchestration).