import { defineConfig } from 'vitest/config';

// Workspace-wide architecture tests (boundaries, client security). Package tests run in each package.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
