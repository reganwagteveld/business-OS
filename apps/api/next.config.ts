import type { NextConfig } from 'next';

// API-only Next.js app: route handlers under src/app/api. No pages are served.
const config: NextConfig = {
  serverExternalPackages: ['@prisma/client', 'pg'],
  transpilePackages: ['@business-os/contracts'],
  poweredByHeader: false,
};
export default config;
