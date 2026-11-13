import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// RLS spike and isolation tests: real PostgreSQL behind a transaction-mode pooler (data-model §5.4).
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/isolation/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['dotenv/config'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
