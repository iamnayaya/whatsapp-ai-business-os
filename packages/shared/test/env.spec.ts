import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../src/env';

const base: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  WHATSAPP_ACCESS_TOKEN: 'token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_APP_SECRET: 'secret',
  GEMINI_API_KEY: 'gemini-key',
};

describe('loadEnv', () => {
  it('accepts a valid configuration and applies defaults', () => {
    const env = loadEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.WEBHOOK_PATH).toBe('/webhook/whatsapp');
    expect(env.WHATSAPP_API_VERSION).toBe('v21.0');
    expect(env.BUSINESS_CURRENCY).toBe('NGN');
    expect(env.BUSINESS_TIMEZONE).toBe('Africa/Lagos');
  });

  it('coerces PORT from a string', () => {
    expect(loadEnv({ ...base, PORT: '8080' }).PORT).toBe(8080);
  });

  it('throws EnvValidationError when required keys are missing', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('throws when a required WhatsApp key is missing', () => {
    const { WHATSAPP_APP_SECRET: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/WHATSAPP_APP_SECRET/);
  });
});