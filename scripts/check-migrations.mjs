// Fails if prisma/schema contains changes that have no generated migration
// (implementation plan, Phase 1a). Exit codes from `prisma migrate diff --exit-code`:
// 0 = no difference, 2 = difference, 1 = error.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = 'prisma/migrations';
const hasMigrations = existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith('.') && name !== 'migration_lock.toml');
const from = hasMigrations ? ['--from-migrations', dir] : ['--from-empty'];

const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'diff', ...from, '--to-schema', 'prisma/schema', '--exit-code'], {
  stdio: 'inherit',
});

if (result.status === 2) {
  console.error('\nprisma/schema has changes without a migration. Run `pnpm db:migrate --name <change>` and commit it.');
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(hasMigrations ? 'Migrations match prisma/schema.' : 'No migrations yet and the schema has no models.');
