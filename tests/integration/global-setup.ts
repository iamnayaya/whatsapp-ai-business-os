import 'dotenv/config';
import { execSync } from 'child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

export default async function setup() {
  const pg = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new RedisContainer('redis:7-alpine').start();

  process.env.DATABASE_URL = pg.getConnectionUri();
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getPort()}`;

  // Minimal WhatsApp/other env so loadEnv() passes inside the integration tests.
  process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'TEST_PNID';
  process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify';
  process.env.WHATSAPP_APP_SECRET = 'test-secret';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.NODE_ENV = 'test';

  execSync('npx prisma db push --skip-generate --schema packages/db/prisma/schema.prisma', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
    stdio: 'inherit',
  });

  return async () => {
    await pg.stop();
    await redis.stop();
  };
}