import { describe, expect, it } from 'vitest';

/**
 * Smoke test that the full Nest DI graph compiles — the exact class of failure
 * that would previously slip through (a provider whose dependencies Nest could
 * not resolve, e.g. the PaymentsModule before its useFactory wiring).
 * All connection-touching providers are overridden with fakes so this runs
 * without Postgres, Redis, WhatsApp, or Paystack.
 */
describe('AppModule bootstrap (DI graph)', () => {
  it(
    'compiles the full module graph with every provider resolvable',
    async () => {
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
      process.env.REDIS_URL = 'redis://localhost:6379';
      process.env.WHATSAPP_ACCESS_TOKEN = 'x';
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'x';
      process.env.WHATSAPP_VERIFY_TOKEN = 'x';
      process.env.WHATSAPP_APP_SECRET = 'x';
      process.env.GEMINI_API_KEY = 'x';
      process.env.PAYSTACK_SECRET_KEY = 'x';
      process.env.ADMIN_PASSWORD = 'pw';

      const [{ Test }, { AppModule }, tokens, { PaystackWebhookService }, { WebhookService }] = await Promise.all([
        import('@nestjs/testing'),
        import('../src/app.module'),
        import('../src/tokens'),
        import('../src/payments/paystack-webhook.service'),
        import('../src/webhook/webhook.service'),
      ]);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(tokens.PRISMA)
        .useValue({})
        .overrideProvider(tokens.ANALYTICS_PRISMA)
        .useValue({})
        .overrideProvider(tokens.QUEUE)
        .useValue({})
        .overrideProvider(tokens.PAYMENT_QUEUE)
        .useValue({})
        .overrideProvider(tokens.AUDIT)
        .useValue({ record: async () => undefined })
        .compile();

      // The two services whose DI wiring is non-trivial must be resolvable.
      expect(moduleRef.get(PaystackWebhookService)).toBeDefined();
      expect(moduleRef.get(WebhookService)).toBeDefined();
    },
    60_000,
  );
});