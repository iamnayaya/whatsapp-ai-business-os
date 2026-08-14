# Owner Analytics Dashboard (Phase 8)

An internal, password-protected, **read-only** web dashboard for the business owner.
It answers the six questions a shop owner checks daily without a BI tool:

- **Sales** today / this week / this month
- **Top-selling products** (units + revenue, this month)
- **Peak conversation hours** (last 30 days)
- **Conversion rate** (chatted customers → customers who paid, this month)
- **Abandoned-cart recovery** (follow-ups sent → follow-ups that led to an order)
- **Escalations / complaints** (total, open, angry, refund requests, this month)
- **Recent conversations**, each with a **sentiment** chip (Positive / Neutral / Frustrated)

## Routes

| Route | Purpose |
|---|---|
| `GET /admin` | Dashboard (redirects to `/admin/login` when unauthenticated) |
| `GET /admin/login` | Login page |
| `POST /admin/login` | Verify password, set signed session cookie, redirect to `/admin` |
| `POST /admin/logout` | Clear the cookie |

When `ADMIN_PASSWORD` is unset the whole module is disabled and every route returns
404 (fail-closed).

## Auth

- `ADMIN_PASSWORD` is compared **constant-time** and never stored.
- Successful login mints a stateless cookie `wabiz_admin` =
  `base64url(JSON { exp }).HMAC-SHA256(payload, ADMIN_SESSION_SECRET)`. Tampering
  with the payload, re-signing with a different secret, or presenting an expired
  session is rejected (`packages/analytics/../api/src/analytics/admin-auth.service.ts`).
- Cookie: `HttpOnly; Path=/admin; SameSite=Strict; Max-Age=12h`.
- `ADMIN_SESSION_SECRET` defaults to `ADMIN_PASSWORD` when unset.

## Read-only guarantee

- `AnalyticsService` (`packages/analytics/src/service.ts`) issues **only**
  `$queryRaw` `SELECT` statements — no writes, no mutations.
- When `ANALYTICS_DATABASE_URL` is set, the dashboard uses a **dedicated** Prisma
  client pointed at that URL (e.g. a replica, or a SELECT-only database role) and
  disconnects it on shutdown — it never touches the primary write URL.
- When unset, it reuses the shared `DATABASE_URL` client but still only reads.
- The dashboard is fully server-rendered HTML with **no client-side JavaScript**
  and auto-refreshes every 120s (`<meta http-equiv="refresh">`) — sized for a
  daily 2-minute glance, not an interactive BI tool.

## Sentiment self-assessment (not a separate analysis pass)

The AI agent tags its **own** assessment of the conversation in the same
generation that answers the customer, as a trailing marker:

```
Yes! 50kg Royal Stallion is ₦85,000. Want me to prepare the payment link?
[sentiment: positive]
```

- `parseSentiment` / `extractSentiment` (`packages/ai/src/sentiment.ts`) extract
  the marker **and strip it before the text is sent to WhatsApp**.
- Fallback when the model didn't tag one: an angry escalation scores
  **Frustrated**, everything else **Neutral** (`defaultSentiment`).
- The worker persists the result on the outbound `Message.sentiment` column; the
  dashboard's "Recent conversations" shows the sentiment of the **latest agent
  turn**.

## Timezone correctness

Bucket boundaries are computed in SQL **in the business timezone** (Africa/Lagos
by default) from a single `now` value, avoiding session-timezone ambiguity:

```sql
date_trunc('day', (to_timestamp(<now_ms>/1000.0) AT TIME ZONE $tz) AT TIME ZONE $tz)
```

Aggregations:

| Metric | Definition |
|---|---|
| Sales buckets | `SUM(order.total)` of orders with `status IN (PAID, FULFILLING, FULFILLED)` and `paidAt >= boundary` |
| Conversion | distinct customers with a conversation started this month vs. those among them with a paid order created this month |
| Recovery | `follow_ups` with `status = SENT` and `ledToOrder = true`, per type + overall |
| Escalations | created this month; open / resolved / angry / refund, plus a category breakdown |
| Peak hours | inbound messages in the last 30 days, bucketed by local hour, top 6 |
| Recent conversations | latest agent-turn sentiment via `LATERAL` subqueries |

All money values are decimal (NGN); rates are fractions in `[0, 1]` rendered as
percentages.

## Env

| Key | Meaning |
|---|---|
| `ADMIN_PASSWORD` | Enables the dashboard; compared constant-time |
| `ADMIN_SESSION_SECRET` | Cookie signing secret (defaults to `ADMIN_PASSWORD`) |
| `ANALYTICS_DATABASE_URL` | Optional SELECT-only Postgres URL for the dashboard |

## Tests

```bash
npm test                # unit: packages/analytics (aggregation math), packages/ai (sentiment),
                        # apps/api (auth + controller routes), apps/worker (persistence)
npm run test:integration # CI: tests/integration/analytics.integration.spec.ts verifies the raw SQL
                        # against real Postgres (Testcontainers) with seeded sample data and a fixed `now`
```

The integration spec seeds a fixed timeline (orders inside/outside today/week/
month, SENT + SENDING follow-ups, escalations inside/outside the month, messages
with and without sentiment) and asserts every aggregation comes back exact.