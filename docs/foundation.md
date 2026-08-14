# Module: Foundation (Phase 1)

The plumbing everything else hangs off of. It makes the system safe against
duplicate events, slow external calls, and unobservable failure — so the AI
modules (2–8) never have to worry about those concerns.

## What it does

1. **Webhook receiver** (`apps/api`) — Meta posts WhatsApp events to
   `POST /webhook/whatsapp`. The receiver:
   - Verifies the `X-Hub-Signature-256` HMAC against `WHATSAPP_APP_SECRET`
     (constant-time compare).
   - **Stores the FULL raw change into the `events` table BEFORE any
     processing** (`events.event_key` is UNIQUE). Nothing is lost even if
     downstream processing crashes or Meta re-delivers.
   - Parses/validates the payload (Zod) — unknown fields are tolerated.
   - Handles **text, voice notes (audio), images/video/documents, and
     interactive button/list replies** (reply title is extracted as the
     message text).
   - Persists inbound messages, customers, and conversations; enqueues a
     BullMQ job per message.
   - Absorbs duplicates at three layers: UNIQUE `events.event_key`,
     UNIQUE `messages.wa_message_id`, and BullMQ `jobId = waMessageId`.
2. **GET /webhook/whatsapp** — Meta's verification handshake
   (`hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`).
3. **Message queue** (`packages/queue` + `apps/worker`) — BullMQ consumer:
   - 5 attempts, exponential backoff from 5s.
   - Concurrency 5 (≈ 5× current volume headroom: ~2,500 orders/mo peak).
   - Marks messages PROCESSING → PROCESSED; on failure marks FAILED, audits,
     and rethrows so BullMQ retries.
4. **Outbound sender** (`packages/whatsapp`) — wraps the Cloud API with
   retries + exponential backoff + error classification:
   - `sendText(to, body)` — plain messages.
   - `sendTemplate(to, { name, language, components })` — approved templates
     (required for first contact with a customer / outside the 24h window).
   - `markMessageRead`, `getMediaUrl`, `downloadMedia` (Phase 3).
5. **Database schema** (`packages/db/prisma/schema.prisma`) — tables
   `businesses`, `customers`, `conversations`, `messages`, `events`,
   `products`, `stock_levels`, `orders`, `order_items`, `payments`,
   `agent_actions` (audit). Indexed on phone number (`wa_id`), order status,
   and `created_at`. Product/Order/Payment tables exist now so Phases 2/4/7
   don't re-architect.
6. **Audit trail** (`packages/audit`) — every ingest/status-change is written
   to `agent_actions` (actor, action, entity, details). Audit never blocks the
   main flow; failures are logged loudly.
7. **Health** — `GET /health` reports Postgres + Redis connectivity and
   degrades gracefully (never crashes the process) when they're down.

## Inputs / Outputs

- **Input:** Meta Cloud API webhook payload (JSON, HMAC-signed) + env vars.
- **Outputs:**
  - A raw row in `events` per webhook change (full payload) — **written first**.
  - Rows in `messages`, `conversations`, `customers`, `businesses`,
    `agent_actions` (audit).
  - A `whatsapp-messages` BullMQ job per inbound message, jobId = waMessageId.
  - `200 { received: true }` (always — stops Meta retry storms on duplicates).
- **Downstream contract:** the worker handler receives
  `{ messageId, conversationId, customerId, customerWaId, businessId }`.
  Phase 2's Sales Agent is inserted inside `handleInboundMessage` without
  changing this contract.

## How to test locally

```bash
npm test                  # unit: signature, parsing, idempotency logic, retries, client, audit
docker compose up -d      # Postgres + Redis (required only for integration)
npm run test:integration  # real webhook→DB→queue→worker end-to-end idempotency proof
```

Sample signed webhook (PowerShell):

```powershell
$body = '{"object":"whatsapp_business_account","entry":[{"id":"WABA","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"PNID"},"contacts":[{"wa_id":"2348012345678"}],"messages":[{"from":"2348012345678","id":"wamid.1","timestamp":"1700000000","type":"text","text":{"body":"Price?"}}]}}]}]}'
$sig = "sha256=$((& openssl dgst -sha256 -hmac $env:WHATSAPP_APP_SECRET) )"  # see below
```

> Tip: for a real signature in dev, use a tiny script with `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` — same code the service uses.

## Meta setup — exact order (do this before Phase 1 goes live)

1. **Meta Business Account** → create at business.facebook.com (free). Use the
   real business name you'll invoice customers as.
2. **Developer account** → developers.facebook.com → register + create an app
   with **type = Business**.
3. **Add WhatsApp product** to the app.
4. **Verify a business phone number** (SMS) — this is a Meta-side step, not
   your WhatsApp number.
5. **Connect the WABA + number.** Add your existing WhatsApp Business number
   (the one currently on your phone). Meta will log the phone out of the app —
   that's expected and required for Cloud API.
6. From the **WhatsApp > API Setup** tab copy: **Access token** (use the
   *long-lived* system-user token, not the temp one), **Phone number ID**, and
   the **WABA ID**.
7. Under **App settings > App secret**: copy **App secret**.
8. Under **Webhooks**: add a webhook, set **Callback URL** to
   `https://<your-host>/webhook/whatsapp` and **Verify token** to your chosen
   `WHATSAPP_VERIFY_TOKEN`. Meta immediately GETs it — the API must be
   deployed and `.env` set first.
9. **Subscribe** the app to the **messages** webhook field.
10. Fill those values into `.env` (`WHATSAPP_ACCESS_TOKEN`,
    `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_APP_SECRET`,
    `WHATSAPP_VERIFY_TOKEN`).

## Environment variables

Every key is validated at boot (`packages/shared/src/env.ts`) — a missing
required key refuses to start instead of failing mid-request. Full list with
comments lives in `.env.example`.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis connection string (BullMQ) |
| `WHATSAPP_ACCESS_TOKEN` | ✅ | Long-lived system-user token from Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | ✅ | Phone number ID from WhatsApp API Setup tab |
| `WHATSAPP_VERIFY_TOKEN` | ✅ | Your chosen string, echoed back in the GET handshake |
| `WHATSAPP_APP_SECRET` | ✅ | Meta App secret (webhook HMAC) |
| `WHATSAPP_WABA_ID` | | WABA ID (audit/debug metadata) |
| `WHATSAPP_API_VERSION` | | Graph API version, default `v21.0` |
| `NODE_ENV` | | `development` / `test` / `production` |
| `PORT` | | HTTP port, default `3000` |
| `WEBHOOK_PATH` | | Webhook route, default `/webhook/whatsapp` |
| `BUSINESS_NAME` / `BUSINESS_PHONE_NUMBER` / `BUSINESS_CURRENCY` / `BUSINESS_TIMEZONE` | | Business defaults used when auto-provisioning on first webhook |
| `GEMINI_API_KEY` | (worker) | Google AI Studio key — required only to run the worker (Sales Agent) |
| `GEMINI_MODEL` | | Gemini Flash model, default `gemini-flash-latest` |

## Receiving real webhooks locally with ngrok

ngrok gives you a public HTTPS URL that tunnels to your localhost so Meta can
reach your webhook during development.

```bash
# 1. Start Postgres + Redis, install, migrate (see README quickstart)
docker compose up -d
npm install
npm run db:migrate

# 2. Create .env from .env.example and fill in the required keys above
cp .env.example .env

# 3. Start the API and worker (two terminals)
npm run dev:api
npm run dev:worker

# 4. Tunnel localhost:3000 to the internet
ngrok http 3000
# -> https://abcd-12-34-56-78.ngrok-free.app

# 5. In Meta (App > WhatsApp > Configuration > Webhook):
#    Callback URL: https://abcd-12-34-56-78.ngrok-free.app/webhook/whatsapp
#    Verify token: the same string as WHATSAPP_VERIFY_TOKEN
#    -> Meta immediately sends the GET handshake; you should see it verify.
#    Then click "Manage" and Subscribe to the `messages` field.

# 6. Message your WhatsApp number from your personal phone.
#    Check the logs; the raw event is stored in the `events` table first,
#    then a message row + BullMQ job follow.
```

Notes:
- Free ngrok URLs change on every restart — update the Meta callback URL each
  time (or use a paid static domain for convenience).
- Keep the **worker** running too; it drains the `whatsapp-messages` queue.
- The signature check needs the **exact raw body** — our server reads the raw
  body (`rawBody: true`) so ngrok/Express JSON parsing never breaks the HMAC.
- Inspect captured data: `docker exec -it <pg-container> psql -U postgres -d whatsapp_biz_os` then
  `select * from events order by created_at desc limit 5;`

## Budget (Render/Railway, ~under $50/mo)

- Web service (API): free tier.
- Worker: free tier.
- Postgres 16: ~$7–19/mo smallest instance.
- Redis: ~$9–15/mo smallest.
- **Total ~$16–34/mo.** AI API spend is separate (Phase 2) — at your volume
  expect single-digit dollars/mo for text, cents for transcription via a cheap
  Whisper endpoint.
- AWS ECS would start ~$30–60/mo just for compute and is deliberately **not**
  used at this volume; the Docker-first design makes it a no-code-change
  migration later.

## What's intentionally NOT here yet

- The AI Sales Agent lives in its own module now — see [docs/agent.md](agent.md).
  This module only guarantees the plumbing: lossless raw-event capture, ingest,
  queueing, retries, and audit.
- No voice/image understanding (Phase 3): media messages are ingested and
  captured but not answered.
- No outbound sending from the worker beyond agent replies — the WhatsApp
  client (`sendText`, `sendTemplate`, `markMessageRead`, `downloadMedia`) is
  fully built and unit-tested, ready for Phase 3/7 use.
