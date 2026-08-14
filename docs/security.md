# Security & Hardening

Status of the pre-launch hardening pass. Findings that are **fixed**, and
decisions that are **deferred** with rationale. See `README.md` for the
overall system and phase map.

## What is in place

- **Webhook authenticity.** WhatsApp + Paystack webhooks are verified with
  constant-time HMAC comparison over the raw request body (`verifyToken`).
- **SQL injection.** All Prisma queries are parameterized; analytics SQL is
  built from whitelisted, validated literals only.
- **Secrets.** No secrets in code or committed config; everything via env vars
  (`.env` ignored, `.env.example` documents the keys).
- **Rate limiting** (in-memory, per process). Webhook 120/min, Paystack 60/min,
  `/health` 30/min, `/admin/login` 5 per 15 min, kill-switch toggle 10/min.
  Limits apply per remote IP.
- **Security headers** (added in `apps/api/src/main.ts`): `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; `/admin` also gets
  `Cache-Control: no-store` and a restrictive CSP (`default-src 'none'`,
  `style-src 'unsafe-inline'`, `form-action 'self'`, `script-src 'none'`).
- **Cookies.** Session cookies for the admin dashboard carry `Secure` in
  production; the dashboard is password-protected and read-only.
- **Health endpoint.** One shared lazy Redis client (no connection per request),
  and error details are suppressed in production.
- **Bootstrap hardening.** `main()` failures call `process.exit(1)` on both the
  API and worker so a misconfigured process fails fast instead of staying half-alive.

## Fixed in this pass

| # | Finding | Fix |
|---|---------|-----|
| 1 | **BLOCKER**: `PaystackWebhookService` registered as a plain provider → Nest could not resolve its (erased) deps → API failed to boot | `PaystackWebhookService` now registered via `useFactory` injecting `APP_CONFIG_TOKEN`, `PRISMA`, `PAYMENT_QUEUE`, `AUDIT`, `LOGGER`; verified by a DI bootstrap smoke test |
| 2 | Paystack retry logic was dead code (`shouldRetry` always false) | `PaystackApiError` now carries a `retryable` flag set from the underlying Axios error (no response / 429 / 5xx); `shouldRetry` uses it; covered by new client tests |
| 3 | Money-critical failures were swallowed | Stock-race cancel + confirmation reset wrapped in `withRetry` (3 attempts, 200/2000ms); cancel failures rethrow + log loudly; lost-receipt logged if reset fails |
| 4 | Empty payment-link nudge bug | Follow-up engine skips the payment nudge when there is no `paymentUrl` (`no_payment_url`), with a warning log |
| 5 | No rate limiting, per-request Redis connections on `/health`, raw error strings leaked | Rate-limit guard applied; shared lazy Redis client with shutdown disconnect; prod-safe health details |
| 6 | Missing security headers/CSP, cookie lacked `Secure`, JS-reliant logout | Headers/CSP middleware; `Secure` cookies in prod; no-JS logout form |
| 7 | Coverage tooling missing | `@vitest/coverage-v8@^3.2.7` (pinned to vitest 3), `test:coverage`, coverage config under `test.coverage`, excludes generated Prisma files. Baseline: ~90% stmts / 78% branches |
| 9a | Voice-note cost spike: audio billed at input-token rates with no cap | Long voice notes (>180s) are answered with a canned reply instead of being transcribed |

## Audit status (npm audit)

`npm audit`: **15 vulnerabilities (3 high, 12 moderate).** Non-breaking
`npm audit fix` clears nothing.

- **3 high**: multer ≤2.1.1 DoS advisories via `@nestjs/platform-express`
  (file-upload cleanup/resource-exhaustion). Latent here: the API exposes no
  multipart/upload endpoint, so multer is never exercised. Active mitigation:
  rate limiting on all public endpoints.
- **12 moderate**: `@nestjs/core` output-injection advisory, `body-parser`
  invalid-limit DoS, `qs`, `express@4.22.1`, plus dev-only `uuid` /
  `testcontainers`.

### Decision: deferred breaking upgrades

Fully clearing the audit requires two breaking upgrades:

1. **NestJS 11 / Express 5** (`@nestjs/platform-express@11.1.29`). Express 5
   changes request/query/path semantics, and the integration suite
   (Testcontainers) cannot run locally in this environment — it is CI-only.
2. **testcontainers@12** (dev-only; needed by the integration specs).

Why deferred: no git repo or CI lane exists yet in this workspace, so a broken
upgrade has no clean revert path and no automated gate. **Recommended**: create
a git repo + CI (GitHub Actions running `npm run test:integration`), then
upgrade Nest to 11 on a branch and merge only if the full unit + integration
suite is green. Re-run `npm audit` after the upgrade to confirm multer is
resolved.

## Deferred (low priority)

- **Retention**: `incoming_events` and `agent_actions` grow unbounded. Plan a
  nightly purge job (e.g. delete `incoming_events` older than 30 days, keep
  `agent_actions` 180 days, summarize/archive first).
- **Centralized retry defaults**: the 5/1000/30000 retry triple is duplicated
  across the WhatsApp/AI/Gemini clients; consolidate into one shared constant.
- **Image size cap**: catalog/product images are accepted without a size limit;
  cap uploads at e.g. 10 MB.
- **Hardcoded audit `businessId: 'unknown'`** in the Paystack webhook service:
  derive the business id from the webhook account instead when possible.

## Baseline coverage

`npm run test:coverage` (excludes generated Prisma files, entrypoints, and the
admin CLI):

```
statements  ~90.2%   branches  ~78.5%   functions  ~81.4%   lines  ~90.2%
```

Lowest files: the Gemini API client (network layer, ~22%) and the analytics
query service (raw SQL, only integration-tested). Both are exercised by CI-only
integration specs.
