// Source-level rules that import graphs cannot express (docs/architecture.md §5.3, §13.1, ADR 0002, ADR 0005).
// Import-graph rules (packages, module APIs, layers, Prisma location, cycles, vendor SDKs) live in
// .dependency-cruiser.cjs. Both run in `pnpm boundaries` and in CI.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** The API's source tree; the only code that may reach PostgreSQL. */
export const SERVER_ROOT = 'apps/api/src';
/** Every source tree that ships to a desktop or browser client. */
export const CLIENT_ROOTS = ['apps/desktop/src', 'apps/web/src', 'packages/app/src', 'packages/ui/src', 'packages/contracts/src'];

/** Package specifiers a client must never import: database drivers, Prisma, server frameworks, the API itself. */
const CLIENT_FORBIDDEN_IMPORTS = [
  /^server-only$/,
  /^(@prisma\/[^/]+|prisma|pg|postgres|@neondatabase\/[^/]+|@vercel\/postgres|next|dotenv)(\/|$)/,
  /^@business-os\/api(\/|$)/,
  /^@\//, // the API's path alias
];

/** Database configuration has no business in client code (it would end up in the bundle). */
const CLIENT_DATABASE_CONFIG = /\b(?:DATABASE_URL|MIGRATION_DATABASE_URL|SHADOW_DATABASE_URL|PGPASSWORD)\b|\bpostgres(?:ql)?:\/\//;

// AWS-style region ids and Vercel function region codes.
const REGION_LITERAL =
  /\b(?:(?:us|eu|ap|ca|sa|me|af|il|mx)-(?:east|west|north|south|central|northeast|southeast|northwest|southwest)-\d|(?:iad|cle|pdx|sfo|yul|gru|lhr|cdg|fra|arn|dub|hnd|kix|icn|sin|syd|bom|cpt|hkg)1)\b/;

// Migration-owner credentials must never reach the running API (architecture §7.3 layer 4).
const OWNER_CREDENTIALS = /\b(?:MIGRATION_DATABASE_URL|SHADOW_DATABASE_URL)\b/;

// Reading the tenant id from a context object: ctx.businessId, tenant.businessId,
// or `const { businessId } = ctx`.
const TENANT_ID_READ = [
  /\b(?:ctx|context|tenant|tenantContext|tenantCtx)\??\.businessId\b/,
  /\{[^}]*\bbusinessId\b[^}]*\}\s*=\s*(?:ctx|context|tenant|tenantContext|tenantCtx)\b/,
];

function importsOf(content) {
  const specs = [];
  const re = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of content.matchAll(re)) specs.push(m[1] ?? m[2]);
  return specs;
}

function isClientComponent(content) {
  const body = content.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^['"]use client['"]/.test(body);
}

/**
 * Rules for the API source tree.
 * @param {Array<[string, string]>} files pairs of [path relative to apps/api/src, file content]
 * @returns {string[]} violations, each prefixed with its rule name
 */
export function serverViolations(files) {
  const errors = [];
  for (const [name, content] of files) {
    if (name.startsWith('generated/')) continue;

    if (isClientComponent(content)) {
      errors.push(`api-has-no-client-components: ${name} is marked 'use client'; UI lives in packages/app (ADR 0005)`);
    }

    if (!/^core\/(tenant|db)\//.test(name) && TENANT_ID_READ.some((re) => re.test(content))) {
      errors.push(`tenant-id-outside-core: ${name} reads businessId from a tenant context; only core/tenant and core/db may`);
    }

    if (name !== 'core/config/migration.ts' && OWNER_CREDENTIALS.test(content)) {
      errors.push(`runtime-owner-credentials: ${name} reads migration-owner credentials; only core/config/migration.ts (migration tooling) may`);
    }

    const region = name === 'core/config/regions.ts' ? null : content.match(REGION_LITERAL);
    if (region) {
      errors.push(`no-region-literals: ${name} contains "${region[0]}"; regions come from validated environment config`);
    }

    // Every tenant route handler goes through tenantRoute (architecture §7.3 layer 2); other v1
    // handlers through publicRoute, except the listed unauthenticated or auth-library endpoints.
    if (/^app\/api\/v1\/.*route\.ts$/.test(name)) {
      const methods = [...content.matchAll(/export\s+(?:async\s+)?(?:const|function)\s+(GET|POST|PUT|PATCH|DELETE)\b(.*)/g)];
      const tenant = name.startsWith('app/api/v1/b/');
      const unwrappedAllowed = /^app\/api\/v1\/(health|me|auth)\//.test(name);
      for (const [, method, rest] of methods) {
        const wrapper = /=\s*(tenantRoute|publicRoute)\(/.exec(rest)?.[1];
        if (tenant && wrapper !== 'tenantRoute') errors.push(`tenant-route-wrapper: ${name} ${method} must be defined with tenantRoute`);
        if (!tenant && !wrapper && !unwrappedAllowed) errors.push(`tenant-route-wrapper: ${name} ${method} must use publicRoute (or be an allowed unauthenticated endpoint)`);
      }
    }

    // The bos_auth client can read password hashes and session data (data-model §5.1).
    if (name !== 'modules/identity/server/auth-adapter.ts' && importsOf(content).some((spec) => /(^|\/)core\/db\/auth-client(\.ts)?$/.test(spec))) {
      errors.push(`auth-client-only-in-identity: ${name} imports the bos_auth client; only modules/identity/server/auth-adapter.ts may`);
    }
    if (name !== 'core/config/schema.ts' && name !== 'core/db/auth-client.ts' && /\bAUTH_DATABASE_URL\b/.test(content)) {
      errors.push(`auth-client-only-in-identity: ${name} reads AUTH_DATABASE_URL; only core/db/auth-client.ts may`);
    }
    // Better Auth is an implementation detail of the identity module (architecture §7.1).
    if (!name.startsWith('modules/identity/') && importsOf(content).some((spec) => /^better-auth(\/|$)/.test(spec))) {
      errors.push(`auth-library-only-in-identity: ${name} imports better-auth; use the identity module's public API`);
    }
  }
  return errors;
}

/**
 * Rules for desktop, web and shared client source trees.
 * @param {Array<[string, string]>} files pairs of [path relative to the repository root, file content]
 * @returns {string[]} violations, each prefixed with its rule name
 */
export function clientViolations(files) {
  const errors = [];
  for (const [name, content] of files) {
    for (const spec of importsOf(content)) {
      const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(name), spec)) : spec;
      if (target.startsWith('apps/api/') || CLIENT_FORBIDDEN_IMPORTS.some((re) => re.test(target))) {
        errors.push(`client-imports-server: ${name} imports ${spec}; clients reach the API over HTTPS only`);
      }
    }

    const dbConfig = content.match(CLIENT_DATABASE_CONFIG);
    if (dbConfig) {
      errors.push(`client-database-config: ${name} contains "${dbConfig[0]}"; clients never connect to PostgreSQL`);
    }

    const region = content.match(REGION_LITERAL);
    if (region) {
      errors.push(`no-region-literals: ${name} contains "${region[0]}"; regions come from validated environment config`);
    }
  }
  return errors;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name)) : SOURCE.test(e.name) ? [resolve(dir, e.name)] : [],
  );
}

/** Reads every source file under `root`, named relative to `relativeTo` (default: `root`). */
export function readSourceTree(root, relativeTo = root) {
  return walk(root).map((path) => [relative(relativeTo, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]);
}

/** Runs every source rule on the repository at `repoRoot`. */
export function checkRepository(repoRoot) {
  const server = readSourceTree(resolve(repoRoot, SERVER_ROOT));
  const clients = CLIENT_ROOTS.filter((root) => existsSync(resolve(repoRoot, root))).flatMap((root) =>
    readSourceTree(resolve(repoRoot, root), repoRoot),
  );
  return { files: server.length + clients.length, errors: [...serverViolations(server), ...clientViolations(clients)] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { files, errors } = checkRepository(resolve(process.argv[2] ?? '.'));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Source rules passed (${files} files)`);
  }
}
