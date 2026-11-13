import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Migrations always run as the owner role, never as the runtime app role.
// `prisma generate` (run on install) needs no database, so the owner URL is only required by
// commands that connect; they fail with Prisma's "no datasource url" error when it is missing.
// This lets the runtime (Vercel) environment omit owner credentials (docs/deployment.md §3).
const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url, shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } } : {}),
});
