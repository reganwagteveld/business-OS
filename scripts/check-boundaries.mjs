// Source-level rules that import graphs cannot express (docs/architecture.md §5.3, §13.1, ADR 0002).
// Import-graph rules (module APIs, layers, Prisma location, cycles, vendor SDKs) live in
// .dependency-cruiser.cjs. Both run in `pnpm boundaries` and in CI.
import { readFileSync, readdirSync } from 'node:fs';
import { posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Server-only targets, as paths relative to src/ (or bare package names). */
const SERVER_ONLY = [
  /^server-only$/,
  /^(@prisma\/client|@prisma\/adapter-pg|pg)(\/|$)/,
  /^core\/(db|tenant|config)(\/|$)/,
  /^modules\/[^/]+\/server(\/|$)/,
  /^generated\/prisma(\/|$)/,
];

// AWS-style region ids and Vercel function region codes.
const REGION_LITERAL =
  /\b(?:(?:us|eu|ap|ca|sa|me|af|il|mx)-(?:east|west|north|south|central|northeast|southeast|northwest|southwest)-\d|(?:iad|cle|pdx|sfo|yul|gru|lhr|cdg|fra|arn|dub|hnd|kix|icn|sin|syd|bom|cpt|hkg)1)\b/;

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

/** Normalises an import specifier to a path relative to src/, or a bare package name. */
function normalise(fromFile, spec) {
  if (spec.startsWith('@/')) return spec.slice(2);
  if (spec.startsWith('.')) return posix.normalize(posix.join(posix.dirname(fromFile), spec));
  return spec;
}

function isClientComponent(content) {
  const body = content.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, '');
  return /^['"]use client['"]/.test(body);
}

/**
 * @param {Array<[string, string]>} files pairs of [path relative to src/, file content]
 * @returns {string[]} violations, each prefixed with its rule name
 */
export function violations(files) {
  const errors = [];
  for (const [name, content] of files) {
    if (name.startsWith('generated/')) continue;

    if (isClientComponent(content)) {
      for (const spec of importsOf(content)) {
        const target = normalise(name, spec).replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
        if (SERVER_ONLY.some((re) => re.test(target))) {
          errors.push(`client-imports-server: ${name} is a client component and imports ${spec}`);
        }
      }
    }

    if (!/^core\/(tenant|db)\//.test(name) && TENANT_ID_READ.some((re) => re.test(content))) {
      errors.push(`tenant-id-outside-core: ${name} reads businessId from a tenant context; only core/tenant and core/db may`);
    }

    const region = name === 'core/config/regions.ts' ? null : content.match(REGION_LITERAL);
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

export function readSourceTree(root) {
  return walk(root).map((path) => [relative(root, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')]);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const files = readSourceTree(resolve(process.argv[2] ?? 'src'));
  const errors = violations(files);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Source rules passed (${files.length} files)`);
  }
}
