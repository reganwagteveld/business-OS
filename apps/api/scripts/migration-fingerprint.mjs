// Prints the fingerprint the read-only preflight (scripts/search-index-preflight.sql, query 2) must match:
// md5 over "name:checksum" for every migration in prisma/migrations, sorted by name, where checksum is
// Prisma's (sha256 hex of migration.sql). Excludes the named migrations (default: the search migration),
// so it describes production BEFORE that migration. Reads files only; never connects to a database.
//   node scripts/migration-fingerprint.mjs [--exclude 20261206000000_search_indexes]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const i = args.indexOf('--exclude');
const exclude = new Set((i >= 0 ? args[i + 1] ?? '' : '20261206000000_search_indexes').split(',').filter(Boolean));
const dir = resolve(import.meta.dirname, '../prisma/migrations');
const names = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory() && !exclude.has(d)).sort();
const pairs = names.map((name) => `${name}:${createHash('sha256').update(readFileSync(join(dir, name, 'migration.sql'))).digest('hex')}`);
console.log(`migrations: ${names.length}, latest: ${names[names.length - 1]}`);
console.log(`fingerprint: ${createHash('md5').update(pairs.join(',')).digest('hex')}`);
