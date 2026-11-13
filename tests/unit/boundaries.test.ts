/**
 * Proves every architectural boundary rule catches a real violation (implementation plan, Phase 1a).
 * Import-graph rules: each case writes a tiny source tree into tests/.tmp and runs
 * dependency-cruiser with the project's own .dependency-cruiser.cjs.
 * Source rules: scripts/check-boundaries.mjs on in-memory files.
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cruise, type ICruiseResult, type IConfiguration } from 'dependency-cruiser';
import { readSourceTree, violations } from '../../scripts/check-boundaries.mjs';

const require = createRequire(import.meta.url);
const config = require('../../.dependency-cruiser.cjs') as IConfiguration;
const TMP = resolve(__dirname, '../.tmp');
let caseNo = 0;

async function ruleViolations(files: Record<string, string>): Promise<string[]> {
  const base = resolve(TMP, `case-${++caseNo}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(base, path)), { recursive: true });
    writeFileSync(resolve(base, path), content);
  }
  const { output } = await cruise(['src'], {
    ...config.options,
    tsConfig: undefined,
    baseDir: base,
    ruleSet: { forbidden: config.forbidden },
    validate: true,
  });
  const result = output as ICruiseResult;
  return result.summary.violations.map((v) => v.rule.name);
}

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('import-graph rules (dependency-cruiser)', () => {
  it('allows a module to use another module through its index.ts', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import { x } from '../identity/index';\nexport const y = x;\n",
        'src/modules/identity/index.ts': 'export const x = 1;\n',
      }),
    ).toEqual([]);
  });

  it('forbids a deep import into another module', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import { repo } from '../identity/server/repo';\nexport const y = repo;\n",
        'src/modules/identity/server/repo.ts': 'export const repo = 1;\n',
      }),
    ).toContain('module-public-api-only');
  });

  it('forbids app, zones and ui reaching into module internals', async () => {
    expect(
      await ruleViolations({
        'src/zones/customer/zone.ts': "import { repo } from '../../modules/customers/server/repo';\nexport const z = repo;\n",
        'src/modules/customers/server/repo.ts': 'export const repo = 1;\n',
      }),
    ).toContain('layers-use-module-public-api');
  });

  it('forbids modules importing the app layer', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import page from '../../app/page';\nexport const y = page;\n",
        'src/app/page.ts': 'export default 1;\n',
      }),
    ).toContain('modules-not-to-app');
  });

  it('forbids core depending on modules', async () => {
    expect(
      await ruleViolations({
        'src/core/audit/index.ts': "import { x } from '../../modules/customers/index';\nexport const y = x;\n",
        'src/modules/customers/index.ts': 'export const x = 1;\n',
      }),
    ).toContain('core-is-the-kernel');
  });

  it('forbids database packages outside core/db, and allows them inside it', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import pg from 'pg';\nexport const y = pg;\n",
      }),
    ).toContain('database-access-only-in-core-db');
    expect(
      await ruleViolations({
        'src/core/db/index.ts': "import pg from 'pg';\nexport const y = pg;\n",
      }),
    ).toEqual([]);
  });

  it('forbids the generated Prisma client outside core/db', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import { PrismaClient } from '../../generated/prisma/client';\nexport const y = PrismaClient;\n",
        'src/generated/prisma/client.ts': 'export class PrismaClient {}\n',
      }),
    ).toContain('database-access-only-in-core-db');
  });

  it('forbids vendor platform SDKs inside modules', async () => {
    expect(
      await ruleViolations({
        'src/modules/customers/index.ts': "import { kv } from '@vercel/kv';\nexport const y = kv;\n",
        'node_modules/@vercel/kv/package.json': '{"name":"@vercel/kv","main":"index.js"}',
        'node_modules/@vercel/kv/index.js': 'exports.kv = 1;\n',
      }),
    ).toContain('no-vendor-sdk-in-modules');
  });

  it('forbids circular dependencies', async () => {
    expect(
      await ruleViolations({
        'src/modules/a/index.ts': "import { b } from '../b/index';\nexport const a = () => b;\n",
        'src/modules/b/index.ts': "import { a } from '../a/index';\nexport const b = () => a;\n",
      }),
    ).toContain('no-circular');
  });
});

describe('source rules (scripts/check-boundaries.mjs)', () => {
  const rule = (files: Array<[string, string]>) => violations(files).map((v) => v.split(':')[0]);

  it('forbids client components importing server-only code', () => {
    expect(rule([['ui/widget.tsx', "'use client';\nimport { db } from '@/core/db';\n"]])).toEqual(['client-imports-server']);
    expect(rule([['app/x/form.tsx', '"use client"\nimport \'server-only\';\n']])).toEqual(['client-imports-server']);
    expect(rule([['modules/customers/ui/form.tsx', "'use client';\nimport { r } from '../server/repo';\n"]])).toEqual(['client-imports-server']);
  });

  it('allows server components to import server-only code', () => {
    expect(rule([['app/page.tsx', "import { db } from '@/core/db';\n"]])).toEqual([]);
  });

  it('forbids reading businessId from a tenant context outside core', () => {
    expect(rule([['modules/customers/server/service.ts', 'export const f = (ctx) => ctx.businessId;\n']])).toEqual(['tenant-id-outside-core']);
    expect(rule([['zones/customer/zone.ts', 'const { businessId } = tenant;\n']])).toEqual(['tenant-id-outside-core']);
    expect(rule([['core/tenant/index.ts', 'export const f = (ctx) => ctx.businessId;\n']])).toEqual([]);
  });

  it('forbids hard-coded region names', () => {
    expect(rule([['core/config/env.ts', "const r = 'us-east-1';\n"]])).toEqual(['no-region-literals']);
    expect(rule([['app/layout.tsx', "export const preferredRegion = 'iad1';\n"]])).toEqual(['no-region-literals']);
  });

  it('passes on the real source tree', () => {
    expect(violations(readSourceTree(resolve(__dirname, '../../src')))).toEqual([]);
  });
});
