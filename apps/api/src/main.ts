import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();

  // Defense-in-depth headers on every response; the dashboard pages are
  // server-rendered with no client-side script, so a strict CSP is safe.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/admin')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; script-src 'none'",
      );
    }
    next();
  });

  await app.listen(APP_CONFIG.PORT);
  new Logger('Bootstrap').log(`API listening on :${APP_CONFIG.PORT}`);
  new Logger('Bootstrap').log(`Webhook receiver at GET/POST ${APP_CONFIG.WEBHOOK_PATH}`);
}

bootstrap().catch((err) => {
  const logger = new Logger('Bootstrap');
  logger.error('API failed to start', err instanceof Error ? err.stack : err);
  process.exit(1);
});