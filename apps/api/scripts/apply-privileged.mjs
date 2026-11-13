// Applies prisma/privileged/*.sql in order as an ADMINISTRATIVE role, then records the deployment
// region (data-model §5.5). Run after `prisma migrate deploy`:
//   ADMIN_DATABASE_URL=... DEPLOYMENT_REGION=us-east-1 pnpm db:privileged
// Local/CI: the postgres superuser. Neon: the project owner role. Never the app or owner roles.
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const url = process.env.ADMIN_DATABASE_URL;
const region = process.env.DEPLOYMENT_REGION;
if (!url || !region) {
  console.error('Set ADMIN_DATABASE_URL and DEPLOYMENT_REGION.');
  process.exit(2);
}
const dir = resolve(import.meta.dirname, '../prisma/privileged');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query('BEGIN');
    await client.query(readFileSync(resolve(dir, file), 'utf8'));
    await client.query('COMMIT');
    console.log(`applied ${file}`);
  }
  await client.query(
    'INSERT INTO app_private.deployment_config (singleton, region) VALUES (true, $1) ON CONFLICT (singleton) DO UPDATE SET region = EXCLUDED.region',
    [region],
  );
  console.log(`deployment region: ${region}`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
