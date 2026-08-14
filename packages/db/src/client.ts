export * from './generated/client';

import { PrismaClient } from './generated/client';

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

const globalForPrisma = globalThis as unknown as { __wabizPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__wabizPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__wabizPrisma = prisma;
}
