# Phase 7 — Payment + Delivery

Payments are handled end-to-end with **Paystack**: the sales agent generates a
payment link from a confirmed order, and a webhook with a verified signature
marks the order paid, deducts stock **atomically**, and sends the customer a
confirmation with a tracking reference. Abandoned *payments* are nudged by the
Phase 5 follow-up engine, and staff move orders through delivery
(processing → shipped → delivered) with a small admin CLI.

## Architecture

```
 sales agent ──create_payment_link──► Paystack (checkout) ──charge.success──► /webhook/paystack
       │                                                              │
       └─ Payment row (PENDING, amount = order.total in kobo)        verify HMAC-SHA512 signature
                                                              ┌───────▼────────┐
                                                              │  capture event  │  (IncomingEvent, eventKey UNIQUE)
                                                              └───────┬────────┘
                                                              ┌───────▼────────┐
                                                              │  PAYMENT_EVENTS │  BullMQ, concurrency 1, jobId = eventKey
                                                              └───────┬────────┘
                                                              ┌───────▼────────┐
                                                              │ PaymentService │  claim → validate → $transaction → confirm
                                                              └───────┬────────┘
                                                              order PAID + tracking, stock deducted, WhatsApp confirmation
```

Three packages own this:

- `packages/paystack` — the HTTP client (`initializeTransaction`) and
  `verifyPaystackSignature` (HMAC-SHA512, constant-time compare).
- `packages/payment` — `PaymentService`, the money-critical handler.
- `packages/queue` — the `PAYMENT_EVENTS` BullMQ queue (concurrency **1**, so
  two webhooks for the same reference never process in parallel).

## Security reasoning

Every rule below exists because a payment system is attacked at the seams —
fake webhooks, forged amounts, and double charges. The design follows a simple
principle: **never trust the webhook, the model, or the network — trust the
database and the signature.**

1. **Signature verification before anything else.** Paystack signs each webhook
   with HMAC-SHA512 over the **raw body** using the secret key. The controller
   (`apps/api/src/payments/paystack.controller.ts`) verifies
   `x-paystack-signature` against the raw body **before** parsing JSON; a bad
   signature is a 401, and the body is never even touched by handlers. The API
   boots with `rawBody: true` so the exact bytes are available.
2. **Amounts come from the database, never the wire.** The price is set when
   the payment link is created, from `order.total` (converted to kobo), not from
   anything the model says. On `charge.success` the webhook's amount is compared
   against the stored `Payment.amount`; a mismatch marks the payment `FAILED`
   with a `PAYMENT_FAILED` audit and leaves the order untouched. A forged or
   truncated webhook cannot set a price.
3. **Two layers of idempotency, so a duplicate webhook is a no-op.** Paystack
   (and any retrying sender) may deliver the same event more than once:
   - `IncomingEvent.eventKey` is UNIQUE — a raw event can only be captured once
     (a P2002 collision is swallowed as "already seen").
   - The BullMQ job id is the event key, so the queue itself cannot enqueue it
     twice.
   - `PaymentService` claims the payment with an atomic `updateMany` guarded by
     `status != SUCCESS`; a second delivery finds nothing to claim and returns
     `duplicate`.
   - The order confirmation is guarded by `Order.confirmationSentAt` — the
     customer never receives two "paid" messages.
4. **Stock is never allowed to go negative.** The deduction runs inside a
   `$transaction` with a conditional `updateMany { where: { quantity: { gte: n } } }`.
   Exactly one of two simultaneous payments for the last unit wins; the loser
   gets a `StockRaceError`, its transaction rolls back, and the order is
   cancelled with a loud `STOCK_RACE_CONFLICT` audit note
   (`REQUIRES MANUAL REFUND`). The payment itself stays `SUCCESS` (money was
   taken) — the cancellation is an explicit signal that a human must refund.
5. **Secrets live in env, and the system fails closed.** `PAYSTACK_SECRET_KEY`
   and `PAYSTACK_PUBLIC_KEY` are optional env vars; if the secret is missing the
   webhook handler is never registered and `create_payment_link` refuses with
   "not configured". Nothing is hardcoded.
6. **Transport security.** Paystack is contacted over HTTPS, and in production
   the webhook endpoint sits behind the TLS-terminating edge; the signature
   scheme is used *because* we cannot trust any intermediary.
7. **Everything is audited.** `PAYMENT_LINK_CREATED`, `PAYMENT_WEBHOOK_RECEIVED`,
   `PAYMENT_CONFIRMED`, `PAYMENT_FAILED`, `STOCK_DEDUCTED`,
   `PAYMENT_CONFIRMATION_SENT`, `STOCK_RACE_CONFLICT`, `DELIVERY_STATUS_UPDATED`
   — every money/stock-affecting step lands in `agent_actions` so a full
   post-mortem is always possible.

## Flows

### Link creation (`create_payment_link` tool, `packages/ai/src/tools.ts`)

- Reads the order from the DB and refuses if it is already `PAID`/`CANCELLED`
  or if Paystack is not configured.
- Reuses a still-`PENDING` payment if one exists (no double links).
- Creates the Paystack transaction with `amountKobo = order.total * 100`,
  a reference `PAY-{orderId}-{uuid8}` (greppable in the Paystack dashboard),
  and the customer email `{waId}@wa.local`.
- Stores a `Payment` row (`PENDING`) and flips the order to `PAYMENT_PENDING`.
- Returns the checkout URL to the customer with `PAYMENT_LINK_CREATED` audited.

### Payment success (`PaymentService.handleChargeEvent`)

1. Claims the payment (idempotency layer, above).
2. Validates amount against the stored payment.
3. In a `$transaction`: deducts stock with the conditional `updateMany`,
   flips the order to `PAID`, sets `paidAt`, stamps a tracking reference
   (`TRK-XXXXXXXX`), sets `deliveryStatus = PROCESSING`.
4. Audits `PAYMENT_CONFIRMED` + `STOCK_DEDUCTED`.
5. Claims `confirmationSentAt` and sends the customer a message quoting the
   order, the tracking reference, and the delivery address.
6. If the WhatsApp send fails, the claim is released and the error rethrown;
   the BullMQ retry re-enters through the already-claimed path and re-sends —
   the confirmation is *resumed*, never duplicated.

### Payment failure

`charge.failed` marks the payment `FAILED` (only while `PENDING`) and leaves the
order `PAYMENT_PENDING` — the follow-up engine keeps nudging. A late failure
after a success is ignored (the order stays `PAID`). Unknown references are
ignored with an audit.

### Abandoned payment follow-up

The follow-up engine (`packages/followup/src/engine.ts`) gains a `PAYMENT` pass:
orders that are `PAYMENT_PENDING` with a payment link older than the due window
get a nudge that re-shares the checkout URL. `FollowUp.type` is `CART` or
`PAYMENT`, and `@@unique([conversationId, type, attempt])` keeps the two passes
independent (a cart nudge and a payment nudge are different conversations).
Caps, quiet hours, and cadence rules are shared with the cart pass.

### Delivery tracking (`apps/admin`)

Staff move orders with `npm run admin:delivery` (list / update). Transitions are
pure functions in `apps/admin/src/delivery.rules.ts`:
`PENDING → PROCESSING → SHIPPED → DELIVERED`, no skipping or reversing.
Each change writes `DELIVERY_STATUS_UPDATED` to the audit log. `deliveryStatus`,
`trackingReference`, `deliveryAddress`, and `notes` are surfaced to the
logistics agent via `get_order_status`, so "where is my order" is answered from
the database.

## Schema changes (migration `20260816000000_payments_delivery`)

- `Order` — `paidAt DateTime?`, `deliveryStatus` (default `PENDING`),
  `trackingReference String? @unique`, `confirmationSentAt DateTime?`.
- `FollowUp` — `type` (default `CART`) + `@@unique([conversationId, type, attempt])`.
- `Payment` — `amount Int` (kobo), `providerPayload Json?`,
  `status` (`PENDING`/`SUCCESS`/`FAILED`).

## Tests

- `packages/paystack/test/signature.spec.ts` — HMAC verification, tamper
  rejection, constant-time compare.
- `packages/payment/test/service.spec.ts` — success, duplicate delivery, failed
  payment, late-failure no-op, amount mismatch, **stock race** (two concurrent
  payments for the last unit), confirmation re-send on retry, unknown reference.
- `packages/followup/test/engine.spec.ts` — payment-pass scans, caps, quiet
  hours, and CART/PAYMENT independence.
- `packages/ai/test/tools.spec.ts` — `create_payment_link` happy path, reuse,
  not-configured, already-paid/cancelled refusal.
- `apps/api/test/paystack-webhook.service.spec.ts` — signature + event capture,
  duplicate-event idempotency (P2002).
- `apps/admin/test/delivery.rules.spec.ts` — allowed/denied transitions.
- `tests/integration/payments.integration.spec.ts` — the same scenarios against
  real Postgres, including a **real-concurrency** stock race.
  Run with `npm run test:integration` (requires Docker).