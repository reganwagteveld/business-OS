import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// UI V2-B2-1 visual harness: the real shared App, every API call answered in the browser by the
// in-memory test fakes (packages/app/tests/support). No server, no database, sample data only. Dev-only.
export default defineConfig({
  root: `${import.meta.dirname}/harness`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { 'node:crypto': `${import.meta.dirname}/harness/crypto-shim.ts` } },
  server: { host: '127.0.0.1', port: 5199, strictPort: true, fs: { allow: ['../../..'] } },
});
