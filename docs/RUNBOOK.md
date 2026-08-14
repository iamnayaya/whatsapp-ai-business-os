# Runbook — what to check first

Operational runbook for WhatsApp AI Business OS. Read the relevant scenario,
run the checks top-to-bottom, and don't skip steps. Every diagnostic is a
read-only query against Postgres/Redis or a log grep, so it is safe to run
against production.

Quick links: [messages](#a-messages-stop-being-received) ·
[payments](#b-payments-arent-confirming) ·
[bad AI](#c-the-ai-starts-giving-bad-responses) ·
[kill switch](#kill-switch-quick-reference) ·
[dashboard](#owner-dashboard)

---

## A. Messages stop being received

Customers text, nobody answers, no replies going out.

1. **Is the API up?** `curl https://<your-domain>/health`
   - `status: degraded` → `database`/`redis` shows what is down. Fix the
     dependency first (see Render/Railway service status).
   - Connection refused/timeout → the API process died. Check logs
     (`api2.err.log` locally, or the platform log tab). A boot failure here is
     almost always a **missing/invalid env var** — the app exits fast with the
     reason. Re-verify `WHATSAPP_*`, `DATABASE_URL`, `REDIS_URL`.
2. **Are webhooks arriving?** Count recent raw events:
   ```sql
   SELECT status, count(*) FROM events
   WHERE "createdAt" > now() - interval '30 minutes'
   GROUP BY status;
   ```
   - **Zero rows** → Meta is not delivering. Check the **webhook URL is
     reachable** (`https://<your-domain>/webhook/whatsapp` returns 404/200?),
     the subscription is still **Active** in Meta's app (it silently drops when
     the verify token or app is removed), and that `WEBHOOK_PATH` matches the
     subscribed path.
   - **Lots of `FAILED`** → ingestion is breaking. Check the `WEBHOOK_EVENT_FAILED`
     / `MESSAGE_INGEST_FAILED` rows in `agent_actions`:
     ```sql
     SELECT action, count(*) FROM agent_actions
     WHERE "createdAt" > now() - interval '30 minutes'
       AND action IN ('WEBHOOK_EVENT_FAILED','MESSAGE_INGEST_FAILED')
     GROUP BY action;
     ```
     Most common: wrong `WHATSAPP_APP_SECRET` (signature 401s) or a schema/DB
     error during the write.
   - **Many `PENDING`** → events are being stored but the **worker is not
     draining the queue**. Skip to step 3.
3. **Is the worker alive and draining?**
   - Logs show `worker started`? Check Redis queue depth:
     ```bash
     redis-cli LLEN bull:whatsapp-messages:wait
     ```
     A large number with a healthy worker means jobs are failing fast — grep
     worker logs for `job failed`. If the worker process is down, restart it;
     the queue preserves the work (BullMQ keeps jobs for 7 days on failure).
   - Worker dies at boot? It refuses to start without `GEMINI_API_KEY` and a
     valid `DATABASE_URL`/`REDIS_URL`. Those are the first three env vars to
     check.
4. **Is the kill switch on?** `redis-cli GET ops:kill-switch` → if `1`, the AI
   agent is intentionally paused (fallback replies only). See
   [kill switch](#kill-switch-quick-reference). Note the fallback replies are
   sent, so messages *are* received — but no real answers go out.
5. **Retries exhausted?** After 5 attempts a message is marked `FAILED` and
   left for review (not retried forever). If it's a transient upstream issue,
   no action is needed; if the count is growing, diagnose the cause in
   `agent_actions.MESSAGE_INGEST_FAILED.details.error`.

---

## B. Payments aren't confirming

Customer paid, Paystack shows the charge, but the order is still unpaid / no
confirmation WhatsApp.

1. **Are charge events arriving?** Paystack's webhook must reach
   `https://<your-domain>/webhook/paystack`.
   - Check Paystack dashboard → Settings → Webhooks: URL exact, **`charge.success`
     and `charge.failed`** enabled. A wrong URL or missing event silently kills
     confirmations.
2. **Were the events stored?**
   ```sql
   SELECT status, count(*) FROM events
   WHERE "createdAt" > now() - interval '1 hour'
   GROUP BY status;
   ```
   - `FAILED` rows → verify `PAYSTACK_SECRET_KEY` is correct on the **worker**
     (signature verification lives there).
3. **Is the payment worker draining?**
   ```bash
   redis-cli LLEN bull:payment-events:wait
   ```
   Grep worker logs for `payment event failed` / `payment event processed`.
   Money work is serialized (concurrency 1) and idempotent by `event_key`, so a
   redelivery or restart is safe — it will just reprocess.
4. **Check the specific order.** `Payment.reference` is unique and idempotent:
   ```sql
   SELECT o."externalRef", o.status, p.reference, p.status, p."confirmedAt"
   FROM orders o LEFT JOIN payments p ON p."orderId" = o.id
   WHERE o."createdAt" > now() - interval '1 day'
   ORDER BY o."createdAt" DESC LIMIT 20;
   ```
   - Payment `PENDING`, no `confirmedAt`, but Paystack says paid → the event
     never got processed (steps 1–3).
   - Order stuck `PAYMENT_PENDING` while payment is `SUCCESS` → the confirmation
     send itself failed. Look for `PAYMENT_CONFIRMATION_SENT` / a lost
     WhatsApp send in `agent_actions` for that order.
5. **Stock race?** `STOCK_RACE_CONFLICT` audit rows mean two orders raced for
   the last item; the losing payment was cancelled and the customer should be
   refunded by you. That is expected behavior, not a bug.

---

## C. The AI starts giving bad responses

Wrong prices, hallucinated products, bad tone.

1. **Kill switch first.** If it's actively harming customers, pause the AI
   immediately, then debug calmly:
   ```bash
   curl -X POST https://<your-domain>/admin/ops/kill-switch \
     -d '{"enabled": true, "password": "<ADMIN_PASSWORD>"}'
   ```
   Customers get the static fallback while you investigate. Resume with
   `{"enabled": false}`.
2. **Find the bad turns.** Pull recent outbound replies + which tools ran:
   ```sql
   SELECT m.text, m.payload->>'routedTo' AS agent, m.sentiment,
          m.payload->>'toolCalls' AS tools, m."createdAt"
   FROM messages m
   WHERE m.direction = 'OUTBOUND'
     AND m."createdAt" > now() - interval '24 hours'
   ORDER BY m."createdAt" DESC LIMIT 50;
   ```
3. **Is it the data or the model?**
   - **Wrong prices/stock** → the product catalog the agent reads is stale.
     Check the product rows (`products` table) and re-run the catalog
     generation/review flow. The agent can only answer what it can see.
   - **Randomly wrong / tone issues** → likely prompt drift (a model update) or
     a bad conversation history. Check `docs/agent.md` and `docs/multi-agent.md`
     for the prompt, then adjust. Look for `principle` in the outbound payload
     to see which guardrail fired.
   - **Too many `AGENT_UNCERTAIN` escalations** → the agent doesn't know the
     answer; that's a catalog coverage issue, not a model fault.
4. **AI errors?** If responses are *failures* rather than wrong content, check
   the AI error spike: `redis-cli GET monitor:count:ai.error:<bucket>` (see the
   worker's alert log) or the `agent_actions.MESSAGE_INGEST_FAILED` error text.
   Usually a rate limit (429) or a dead `GEMINI_API_KEY`.
5. **Regression check.** Bad behavior after a deploy? Roll back that deploy;
   if it's model drift, pin `GEMINI_MODEL` to a known-good version instead of
   `gemini-flash-latest`.

---

## Kill switch quick reference

| Action | Endpoint / command |
|---|---|
| Pause AI (persistent) | `POST /admin/ops/kill-switch` `{"enabled": true, "password": ...}` |
| Pause for 1h (auto-resume) | `POST ...` `{"enabled": true, "ttlSeconds": 3600, "password": ...}` |
| Resume | `POST ...` `{"enabled": false, "password": ...}` |
| Check state | `GET /admin/ops/kill-switch` (session cookie) |
| Emergency (Redis) | `redis-cli SET ops:kill-switch 1` / `redis-cli DEL ops:kill-switch` |

While active: inbound messages get the static fallback; webhooks, payments,
follow-ups, and the dashboard all keep running. The worker checks the flag
before **every** agent run, so it applies within milliseconds — no restart.

---

## Owner dashboard

`https://<your-domain>/admin` (password = `ADMIN_PASSWORD`). Read-only
sales/top-products/peak-hours/conversion/abandoned-cart/escalations/sentiment
views. If it 404s, `ADMIN_PASSWORD` is unset or the dashboard feature flag is
off. It never writes to the primary database (reads `ANALYTICS_DATABASE_URL`
when configured).

---

## If all else fails

1. `GET /health` — DB + Redis reachable?
2. `docker logs` / platform log tab for the **api** and the **worker**
   (grep `error`, `job failed`, `worker error`).
3. Is the **kill switch** accidentally on?
4. Roll back the last deploy.
5. Alerting should have told you already: the monitor fires on failed
   messages/events, pending backlog, and AI error spikes — see
   [`DEPLOYMENT.md`](DEPLOYMENT.md) for the thresholds.