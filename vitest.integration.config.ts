import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
