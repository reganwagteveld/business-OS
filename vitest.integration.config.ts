import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Integration tests run against a real PostgreSQL (docker compose locally, a service container in CI).
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['dotenv/config'],
    testTimeout: 20_000,
    fileParallelism: false,
  },
});
