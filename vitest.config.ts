import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['apps/*/test/unit/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
        },
      },
      {
        // Needs `npm run infra:up`. Uses its own database (gantrix_test) and Valkey DB 2,
        // and a fake Ollama server, so it never touches your data or a real model.
        test: {
          name: 'e2e',
          include: ['apps/server/test/e2e/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
