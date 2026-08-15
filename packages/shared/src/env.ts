import { z } from 'zod';

/** Coerces 'true'/'1'/'false'/'0' to boolean; anything else falls back to the default. */
const boolFromEnv = z.preprocess(
  (v) => {
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
    return v;
  },
  z.boolean(),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).default(3000),
  WEBHOOK_PATH: z.string().min(1).default('/webhook/whatsapp'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  WHATSAPP_ACCESS_TOKEN: z.string().min(1, 'WHATSAPP_ACCESS_TOKEN is required'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, 'WHATSAPP_PHONE_NUMBER_ID is required'),
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().min(1, 'WHATSAPP_APP_SECRET is required'),
  WHATSAPP_API_VERSION: z.string().min(1).default('v21.0'),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-flash-latest'),

  TRANSCRIBER_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).optional(),

  // Phase 5 — abandoned-cart follow-up scan (BullMQ repeatable job).
  FOLLOWUP_SCAN_CRON: z.string().min(1).default('0 */15 * * * *'),
  // Quiet before the first nudge, and before the final nudge (minutes since
  // the customer's last inbound message).
  FOLLOWUP_FIRST_DELAY_MINUTES: z.coerce.number().int().min(1).default(120),
  FOLLOWUP_SECOND_DELAY_MINUTES: z.coerce.number().int().min(1).default(1440),
  // Never text during these local-hours (business timezone). Equal values
  // disable the quiet-hours window entirely.
  FOLLOWUP_QUIET_START: z.coerce.number().int().min(0).max(23).default(21),
  FOLLOWUP_QUIET_END: z.coerce.number().int().min(0).max(23).default(9),
  // Hard cap on follow-ups per abandoned cart.
  FOLLOWUP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(2),

  // Phase 6 — multi-agent orchestration. Support escalates refund requests
  // that exceed this amount (in the business currency) to a human.
  REFUND_ESCALATION_THRESHOLD: z.coerce.number().min(0).default(50000),

  // Phase 7 — Paystack payments. Optional so dev/test can boot without keys;
  // the payment tool and webhook receiver refuse to work when missing.
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_PUBLIC_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.string().min(1).default('https://api.paystack.co'),

  // Phase 8 — Owner Analytics Dashboard. The dashboard is served by the API
  // only when ADMIN_PASSWORD is set (fail-closed: unset = dashboard disabled).
  // ADMIN_SESSION_SECRET signs the login cookie; defaults to ADMIN_PASSWORD.
  ADMIN_PASSWORD: z.string().min(1).optional(),
  ADMIN_SESSION_SECRET: z.string().min(1).optional(),
  // Optional read-only Postgres URL (e.g. a replica or a role with SELECT-only
  // grants). When set, the dashboard queries THIS instead of the shared client,
  // guaranteeing the dashboard can never write to the primary database.
  ANALYTICS_DATABASE_URL: z.string().optional(),

  BUSINESS_NAME: z.string().min(1).default('NAYAYA & CO.'),
  BUSINESS_PHONE_NUMBER: z.string().optional(),
  BUSINESS_CURRENCY: z.string().min(1).default('NGN'),
  BUSINESS_TIMEZONE: z.string().min(1).default('Africa/Lagos'),

  // --- Deployment & ops (Phase 9) ---
  // In-app error-spike monitoring + alerting, runs inside the WORKER. Set
  // MONITOR_ENABLED=false (or configure no alert channel) to disable.
  MONITOR_ENABLED: boolFromEnv.default(true),
  MONITOR_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(5),
  MONITOR_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  MONITOR_FAILED_MESSAGES_THRESHOLD: z.coerce.number().int().min(0).default(5),
  MONITOR_FAILED_EVENTS_THRESHOLD: z.coerce.number().int().min(0).default(3),
  MONITOR_PENDING_BACKLOG_MINUTES: z.coerce.number().int().min(1).default(10),
  MONITOR_PENDING_BACKLOG_THRESHOLD: z.coerce.number().int().min(0).default(5),
  MONITOR_AI_ERROR_THRESHOLD: z.coerce.number().int().min(0).default(10),
  MONITOR_ALERT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).default(30),

  // Alert channels. Slack is the primary, zero-dependency channel; email uses
  // the built-in SMTP client. Both are optional — without at least one, alerts
  // are logged and dropped.
  SLACK_WEBHOOK_URL: z.string().optional(),
  ALERT_EMAIL_FROM: z.string().optional(),
  ALERT_EMAIL_TO: z.string().optional(),
  ALERT_SMTP_HOST: z.string().optional(),
  ALERT_SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  ALERT_SMTP_SECURE: boolFromEnv.optional(),
  ALERT_SMTP_USER: z.string().optional(),
  ALERT_SMTP_PASS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: z.ZodIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(raw: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues);
  }
  return parsed.data;
}
