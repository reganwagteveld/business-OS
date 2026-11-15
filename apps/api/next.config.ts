import type { NextConfig } from 'next';

// API-only Next.js app: route handlers under src/app/api. No pages are served.
const config: NextConfig = {
  // pdfkit (Finance F5) stays a plain Node dependency: its PNG, font and compression code is not bundled.
  serverExternalPackages: ['@prisma/client', 'pg', 'pdfkit'],
  transpilePackages: ['@business-os/contracts'],
  poweredByHeader: false,
};
export default config;
