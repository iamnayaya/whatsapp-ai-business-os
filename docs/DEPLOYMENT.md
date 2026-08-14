# Deployment guide

WhatsApp AI Business OS is Docker-first and runs the **same image** for the API
(webhook receiver, `/health`, owner dashboard, kill switch) and the worker
(BullMQ consumer: AI agent, follow-ups, payments, monitor). The two processes
are selected with a single `SERVICE` env var (`api` | `worker`) by
[`start.sh`](../start.sh) inside the [`Dockerfile`](../Dockerfile).

Supported targets: **Render** (recommended, one-click blueprint), **Railway**
(same Dockerfile), and a **VPS** (`docker-compose.prod.yml`). Migration to ECS
later is just the same image + a task definition.

---

## 1. Environment variables

Secrets are set as env vars **per service**; nothing is ever committed (`.env`
is git-ignored). Required/optional breakdown:

| Var | API | Worker | Notes |
|---|---|---|---|
| `NODE_ENV` | ✓ `production` | ✓ `production` | |
| `PORT` | ✓ `3000` | – | Render injects its own; keep 3000 for compose |
| `DATABASE_URL` | ✓ | ✓ | Postgres URL (`postgresql://user:pass@host:5432/db`) |
| `REDIS_URL` | ✓ | ✓ | Redis URL (`redis://host:6379`) |
| `WHATSAPP_VERIFY_TOKEN` | ✓ | – | Your random string, given to Meta at webhook setup |
| `WHATSAPP_APP_SECRET` | ✓ | – | Meta app secret (verifies `X-Hub-Signature-256`) |
| `WHATSAPP_ACCESS_TOKEN` | ✓ | ✓ | Long-lived system-user token, WhatsApp product |
| `WHATSAPP_PHONE_NUMBER_ID` | ✓ | ✓ | Number ID, WhatsApp product settings |
| `WHATSAPP_API_VERSION` | opt | opt | Default `v21.0` |
| `GEMINI_API_KEY` | – | ✓ | ai.google.dev → API key (worker refuses to start without it) |
| `GEMINI_MODEL` | – | opt | Default `gemini-flash-latest` |
| `FOLLOWUP_*` | – | opt | Cron + nudge delays (defaults in `.env.example`) |
| `REFUND_ESCALATION_THRESHOLD` | – | opt | NGN threshold for human escalation |
| `PAYSTACK_SECRET_KEY` / `PUBLIC_KEY` | – | opt | Payment link + webhook verification |
| `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` | ✓ | – | Dashboard + kill switch auth. **Required for the kill switch endpoint** |
| `ANALYTICS_DATABASE_URL` | opt | – | Read-only replica URL for the dashboard |
| `SLACK_WEBHOOK_URL` | – | opt | Alert channel (primary) |
| `ALERT_EMAIL_*`, `ALERT_SMTP_*` | – | opt | Alert channel (built-in SMTP) |
| `MONITOR_*` | – | opt | Thresholds (defaults are sane; see `.env.example`) |
| `BUSINESS_NAME`, `BUSINESS_PHONE_NUMBER`, `BUSINESS_CURRENCY`, `BUSINESS_TIMEZONE` | ✓ | ✓ | Auto-provisioning defaults |

Where each secret comes from:

- **Meta / WhatsApp** — developers.facebook.com → your app → WhatsApp → *API Setup* (phone number ID, system-user token, app secret) and your app → *App settings → Basic* (app secret). The **verify token** is any long random string you choose and then paste into Meta's webhook subscription config.
- **Gemini** — https://aistudio.google.com/apikey
- **Paystack** — https://dashboard.paystack.com/#/settings/developers (secret key; the webhook **url** must point at `https://<your-api-domain>/webhook/paystack` — see `paystack.controller.ts` for the exact path).
- **Slack alerting** — https://api.slack.com/messaging/webhooks → create an incoming webhook in a channel.
- **Email alerting** — any SMTP account (Gmail app password, SendGrid, Mailgun, SMTP2GO). `ALERT_SMTP_SECURE=true` + port 465 for implicit TLS, or port 587 + STARTTLS (`false`).

> The webhook *path* for WhatsApp is `WEBHOOK_PATH` (default `/webhook/whatsapp`). In Meta's app, subscribe that URL **plus** the `messages` webhook field. Set `WHATSAPP_VERIFY_TOKEN` before subscribing — the handshake needs it.

---

## 2. Render (recommended)

1. Push this repo to GitHub and edit `repo:` in [`render.yaml`](../render.yaml).
2. Render dashboard → **New → Blueprint** → pick the repo. It creates:
   - `wabiz-api` (web service, health check `/health`)
   - `wabiz-worker` (background worker)
   - `wabiz-db` (managed Postgres) and `wabiz-redis` (managed Redis), wired via `fromDatabase` / `fromService`.
3. For every var marked `sync: false` in `render.yaml` (secrets), open **each service → Environment** and paste the real value (they're intentionally not committed).
4. **Run migrations once** after the first deploy: Render → your Postgres → *Shell* (or the API service → *Shell*) with `DATABASE_URL` set:
   ```bash
   npm run db:deploy   # prisma migrate deploy
   npm run db:seed     # optional: sample catalog
   ```
5. Add the public URL to Meta: subscribe `https://<your-api-domain>/webhook/whatsapp`.
6. Point Paystack's webhook at `https://<your-api-domain>/webhook/paystack`.

Blueprint services auto-redeploy on every push to the default branch.

---

## 3. Railway

1. Create a project → **New service → GitHub repo** (root).
2. Railway auto-detects the `Dockerfile` (see [`railway.json`](../railway.json)); set `SERVICE=api` and the API env vars.
3. Add a **second service** pointing at the same repo, set `SERVICE=worker` + the worker env vars. The entrypoint picks the process from `SERVICE`, so no per-service start command is needed.
4. Provision a **Postgres** and **Redis** plugin; paste their URLs as `DATABASE_URL` / `REDIS_URL` on both services.
5. Run a one-off command `npm run db:deploy` against the Postgres URL, then wire Meta + Paystack as above.

---

## 4. VPS (Docker)

```bash
cp .env.example .env          # fill in real values
docker compose -f docker-compose.prod.yml up -d --build
```

The compose file runs Postgres + Redis in containers, so `.env`'s
`DATABASE_URL`/`REDIS_URL` (localhost values) are overridden per-service to the
in-network hostnames automatically. Then:

```bash
docker compose -f docker-compose.prod.yml run --rm api npm run db:deploy
```

Put a reverse proxy (Caddy is ~5 lines and auto-issues TLS) in front of port
3000, or expose 3000 directly.

---

## 5. Uptime monitoring (external)

`/health` returns `{ "status": "ok" | "degraded", "database": "up"|"down", "redis": "up"|"down" }`. Wire a free external checker to it:

- **UptimeRobot / Better Stack** → monitor `https://<your-api-domain>/health`, keyword `"ok"`, alert to your email.
- Render's own health check restarts the API if `/health` fails (set in `render.yaml`).

The in-app monitor (Section 6) covers *functional* failures (messages/payments/AI); the external checker covers the box being unreachable at all.

---

## 6. Error-spike alerting (in-app)

Runs inside the **worker** every `MONITOR_INTERVAL_MINUTES` (default 5). It counts, over the last `MONITOR_WINDOW_MINUTES`:

| Signal | Meaning |
|---|---|
| `Message.status = FAILED` ≥ `MONITOR_FAILED_MESSAGES_THRESHOLD` | agent / send pipeline breaking |
| `IncomingEvent.status = FAILED` ≥ `MONITOR_FAILED_EVENTS_THRESHOLD` | webhook ingestion breaking |
| `IncomingEvent.status = PENDING` older than `MONITOR_PENDING_BACKLOG_MINUTES` ≥ `MONITOR_PENDING_BACKLOG_THRESHOLD` | webhook ingestion stalled |
| AI error counter ≥ `MONITOR_AI_ERROR_THRESHOLD` | Gemini errors spiking (counted in Redis by the AI client's `onError` hook) |

Any breach fires an alert to **Slack** (`SLACK_WEBHOOK_URL`) and/or **email**
(SMTP), deduplicated per problem for `MONITOR_ALERT_COOLDOWN_MINUTES`.
Disable with `MONITOR_ENABLED=false`. The alert body points to
[`RUNBOOK.md`](RUNBOOK.md).

---

## 7. Kill switch

The AI agent can be paused without touching anything else:

```bash
# Pause the AI agent (worker answers "we'll reply shortly", no Gemini calls)
curl -X POST https://<your-api-domain>/admin/ops/kill-switch \
  -H 'Content-Type: application/json' \
  -d '{"enabled": true, "password": "<ADMIN_PASSWORD>"}'

# Pause for one hour (auto-resume)
curl -X POST https://<your-api-domain>/admin/ops/kill-switch \
  -d '{"enabled": true, "ttlSeconds": 3600, "password": "<ADMIN_PASSWORD>"}'

# Resume
curl -X POST https://<your-api-domain>/admin/ops/kill-switch \
  -d '{"enabled": false, "password": "<ADMIN_PASSWORD>"}'

# Check state
curl https://<your-api-domain>/admin/ops/kill-switch -b <session-cookie>
```

Emergency failsafe (works even if the API is down): run against Redis directly

```bash
redis-cli SET ops:kill-switch 1          # pause
redis-cli DEL ops:kill-switch            # resume
```

Webhooks, payments, follow-ups, and the dashboard keep running while paused.