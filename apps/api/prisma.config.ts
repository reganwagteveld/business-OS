import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { parseMigrationEnv } from './src/core/config/migration';

// Migrations always run as the owner role, never as the runtime app role.
// `prisma generate` (run on install) needs no database, so the owner URL is only required by
// commands that connect; they fail with Prisma's "no datasource url" error when it is missing.
// This lets the runtime (Vercel) environment omit owner credentials (docs/deployment.md §3).
const migration = process.env.MIGRATION_DATABASE_URL ? parseMigrationEnv(process.env) : undefined;

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  ...(migration ? { datasource: { url: migration.MIGRATION_DATABASE_URL, shadowDatabaseUrl: migration.SHADOW_DATABASE_URL } } : {}),
});
