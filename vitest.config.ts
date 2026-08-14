import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/test/*.spec.ts', 'packages/**/test/*.spec.ts'],
    exclude: ['**/*.integration.spec.ts', '**/node_modules/**', '**/dist/**'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/test/**',
        '**/*.spec.ts',
        '**/src/generated/**',
        '**/*.js',
        '**/*.mjs',
        '**/*.wasm',
        '**/src/main.ts',
        'apps/admin/**',
      ],
      reporter: ['text', 'json-summary'],
    },
  },
});
