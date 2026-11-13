import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Migrations always run as the owner role, never as the runtime app role.
export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: env('MIGRATION_DATABASE_URL'),
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
