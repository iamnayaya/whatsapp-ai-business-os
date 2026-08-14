# WhatsApp AI Business OS

A single AI-run backend that powers a business's WhatsApp Business number: order-taking, customer support, inventory, catalog generation, follow-ups, and analytics — replacing the work of a sales team, support team, inventory manager, content writer, and data analyst.

> **Status: Phase 9 (Deployment & Ops)** — Phases 1–8 live (webhook/queue foundation, Gemini Flash sales agent, Hausa/Pidgin/English voice-note transcription, photo→listing catalog CLI with human review, abandoned-cart follow-up engine, multi-agent orchestration, Paystack payment + delivery, owner analytics dashboard). Phase 9 adds production deployment (Docker → Render/Railway/VPS), error-spike monitoring with Slack/email alerting, and a Redis-backed kill switch that pauses the AI agent without taking the rest of the system down.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (Node.js) |
| API framework | NestJS |
| Database | PostgreSQL 16 (Prisma ORM) |
| Queue | BullMQ on Redis (retries + exponential backoff) |
| WhatsApp | Meta Cloud API (official) |
| AI | Google Gemini Flash (function calling for tool use) |
| Tests | Vitest (unit) + Testcontainers (integration) |
| Ops | Error-spike monitor → Slack/email alerts; Redis-backed AI kill switch |
| Hosting | Docker-first → Render/Railway at current volume |

## Repo layout

```
apps/api      NestJS service: WhatsApp webhook receiver + /health + owner analytics dashboard (/admin)
apps/worker   BullMQ consumer: ingests + runs the AI Sales Agent, sends replies
packages/shared    Zod schemas, env validation, constants, logger, errors, retry
packages/db        Prisma schema + client (PostgreSQL) + product seed script
packages/queue     BullMQ queue/worker wrappers + idempotent enqueue
packages/whatsapp  Meta Cloud API client (retries, backoff, structured errors)
packages/ai        Gemini Flash multi-agent: sales/support/logistics agents, router, orchestrator, tools, tool loop
packages/audit     Audit trail writer (money/stock/customer actions)
packages/followup  Abandoned-cart engine: due detection, quiet hours, item-referencing nudges
packages/paystack  Paystack HTTP client + webhook signature verification (HMAC-SHA512)
packages/payment   Money-critical handler: idempotent payment events, atomic stock deduction, confirmations
packages/analytics Read-only dashboard aggregations (sales, conversion, recovery, escalations, sentiment)
packages/monitor   Error-spike monitoring + Slack/email alerting (runs in the worker)
packages/ops       Operational controls: Redis-backed AI-agent kill switch
apps/admin         Owner CLI: catalog photo→listing and delivery status tracking
tests/integration  Testcontainers integration test setup
docs/              One README per module + DEPLOYMENT.md + RUNBOOK.md
```

## Quickstart (local)

Prereqs: Node >= 20, Docker (for Postgres/Redis and integration tests).

```bash
# 1. Start local Postgres + Redis
docker compose up -d

# 2. Install deps (postinstall generates the Prisma client)
npm install

# 3. Configure env
cp .env.example .env   # fill in real values (incl. GEMINI_API_KEY)

# 4. Apply schema + load the sample product catalog
npm run db:migrate
npm run db:seed

# 5. Run the API and the worker (two terminals)
npm run dev:api
npm run dev:worker
```

Verify: `curl http://localhost:3000/health` → `{ status: "ok", database: "up", redis: "up" }`.

## Testing

```bash
npm test                # unit tests (no Docker required)
npm run test:integration  # integration tests (requires Docker)
npm run typecheck       # tsc --noEmit
```

## Module docs

| Module | Doc | Phase |
|---|---|---|
| Foundation (webhook + queue + schema) | [docs/foundation.md](docs/foundation.md) | 1 ✅ |
| AI Sales Agent (Gemini) | [docs/agent.md](docs/agent.md) | 2 ✅ |
| Voice Note Intelligence | [docs/voice.md](docs/voice.md) | 3 ✅ |
| Auto Catalog Generation | [docs/catalog.md](docs/catalog.md) | 4 ✅ |
| Follow-up / Abandoned Cart | [docs/followup.md](docs/followup.md) | 5 ✅ |
| Multi-Agent Orchestration | [docs/multi-agent.md](docs/multi-agent.md) | 6 ✅ |
| Payment + Delivery | [docs/payments.md](docs/payments.md) | 7 ✅ |
| Owner Analytics Dashboard | [docs/analytics.md](docs/analytics.md) | 8 ✅ |
| Deployment & Ops (Docker/Render/Railway, monitor/alerting, kill switch) | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 9 ✅ |
| Runbook (what to check first) | [docs/RUNBOOK.md](docs/RUNBOOK.md) | 9 ✅ |

## Non-negotiable engineering standards

- Every module ships with automated tests before it's marked done.
- No hardcoded secrets — everything lives in env vars (see `.env.example`).
- Every external call (WhatsApp, payments, AI, DB) has error handling + retries with backoff + logging.
- Idempotency: `events.event_key`, `Message.waMessageId`, `Payment.reference`, and `Order.externalRef` are UNIQUE — a webhook or payment confirmation delivered twice is a no-op.
- Every AI action touching money, stock, or a real customer message is written to the `agent_actions` table.
- One README per module explaining I/O and how to test locally.

## Assumptions locked in during Phase 1 planning

- Physical goods, Nigeria, NGN, Paystack (Phase 7), single WhatsApp number.
- 100–500 orders/mo now; schema/queue sized for **5x (2,500/mo)** headroom.
- Budget under ~$50/mo for infra → Render/Railway; Docker-first so ECS is a free migration later.
- Fully autonomous order-taking is the target; the human-escalation seam is built (Phase 2: conversation `ESCALATED` + audit; Phase 6: reviewable `escalations` queue with reason + category), with the staff delivery channel arriving in a later phase.