import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // The real package throws outside a React Server Components bundle.
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
