import { defineConfig } from 'vitest/config';

// Run only through `pnpm --filter @business-os/e2e e2e` (scripts/run.mjs), which provisions the database and
// the API server and sets E2E_*. There is deliberately no `test` script, so `pnpm test` never starts it.
export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    reporters: process.env.E2E_REPORT_JSON ? ['default', ['json', { outputFile: process.env.E2E_REPORT_JSON }]] : ['default'],
  },
});
