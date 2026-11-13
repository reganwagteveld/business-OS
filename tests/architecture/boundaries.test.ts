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
import { checkRepository, clientViolations, serverViolations } from '../../scripts/check-boundaries.mjs';

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
  const roots = ['apps', 'packages'].filter((root) => Object.keys(files).some((path) => path.startsWith(`${root}/`)));
  const { output } = await cruise(roots, {
    ...config.options,
    tsConfig: undefined,
    baseDir: base,
    ruleSet: { forbidden: config.forbidden },
    validate: true,
  });
  const result = output as ICruiseResult;
  return result.summary.violations.map((v) => v.rule.name);
}

const pgPackage = {
  'node_modules/pg/package.json': '{"name":"pg","main":"index.js"}',
  'node_modules/pg/index.js': 'module.exports = {};\n',
};

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('import-graph rules (dependency-cruiser)', () => {
  it('allows a module to use another module through its index.ts', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import { x } from '../identity/index';\nexport const y = x;\n",
        'apps/api/src/modules/identity/index.ts': 'export const x = 1;\n',
      }),
    ).toEqual([]);
  });

  it('forbids a deep import into another module', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import { repo } from '../identity/server/repo';\nexport const y = repo;\n",
        'apps/api/src/modules/identity/server/repo.ts': 'export const repo = 1;\n',
      }),
    ).toContain('module-public-api-only');
  });

  it('forbids route handlers reaching into module internals', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/app/api/v1/customers/route.ts': "import { repo } from '../../../../modules/customers/server/repo';\nexport const z = repo;\n",
        'apps/api/src/modules/customers/server/repo.ts': 'export const repo = 1;\n',
      }),
    ).toContain('routes-use-module-public-api');
  });

  it('forbids modules importing the app layer', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import page from '../../app/page';\nexport const y = page;\n",
        'apps/api/src/app/page.ts': 'export default 1;\n',
      }),
    ).toContain('modules-not-to-app');
  });

  it('forbids core depending on modules', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/core/audit/index.ts': "import { x } from '../../modules/customers/index';\nexport const y = x;\n",
        'apps/api/src/modules/customers/index.ts': 'export const x = 1;\n',
      }),
    ).toContain('core-is-the-kernel');
  });

  it('forbids database packages outside core/db, and allows them inside it', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import pg from 'pg';\nexport const y = pg;\n",
        ...pgPackage,
      }),
    ).toContain('database-access-only-in-core-db');
    expect(
      await ruleViolations({
        'apps/api/src/core/db/index.ts': "import pg from 'pg';\nexport const y = pg;\n",
        ...pgPackage,
      }),
    ).toEqual([]);
  });

  it('forbids the generated Prisma client outside core/db', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import { PrismaClient } from '../../generated/prisma/client';\nexport const y = PrismaClient;\n",
        'apps/api/src/generated/prisma/client.ts': 'export class PrismaClient {}\n',
      }),
    ).toContain('database-access-only-in-core-db');
  });

  it('forbids vendor platform SDKs inside modules', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/customers/index.ts': "import { kv } from '@vercel/kv';\nexport const y = kv;\n",
        'node_modules/@vercel/kv/package.json': '{"name":"@vercel/kv","main":"index.js"}',
        'node_modules/@vercel/kv/index.js': 'exports.kv = 1;\n',
      }),
    ).toContain('no-vendor-sdk-in-modules');
  });

  it('forbids circular dependencies', async () => {
    expect(
      await ruleViolations({
        'apps/api/src/modules/a/index.ts': "import { b } from '../b/index';\nexport const a = () => b;\n",
        'apps/api/src/modules/b/index.ts': "import { a } from '../a/index';\nexport const b = () => a;\n",
      }),
    ).toContain('no-circular');
  });
});

describe('workspace rules: clients never reach the server or the database (ADR 0005)', () => {
  const api = { 'apps/api/src/core/db/index.ts': 'export const db = 1;\n' };

  it('forbids the desktop app, web app and shared packages importing API code', async () => {
    expect(
      await ruleViolations({ ...api, 'apps/desktop/src/main.ts': "import { db } from '../../api/src/core/db/index';\nexport const x = db;\n" }),
    ).toContain('clients-not-to-api');
    expect(
      await ruleViolations({ ...api, 'packages/app/src/index.ts': "import { db } from '../../../apps/api/src/core/db/index';\nexport const x = db;\n" }),
    ).toContain('clients-not-to-api');
  });

  it.each(['pg', '@prisma/client', 'postgres', '@neondatabase/serverless', 'server-only', 'next'])(
    'forbids clients importing %s',
    async (pkg) => {
      expect(
        await ruleViolations({
          'apps/web/src/main.ts': `import * as m from '${pkg}';\nexport const x = m;\n`,
          [`node_modules/${pkg}/package.json`]: JSON.stringify({ name: pkg, main: 'index.js' }),
          [`node_modules/${pkg}/index.js`]: 'exports.x = 1;\n',
        }),
      ).toContain('clients-no-database-or-server-packages');
    },
  );

  it('keeps the apps independent and packages free of app imports', async () => {
    expect(
      await ruleViolations({
        'apps/desktop/src/main.ts': "import { x } from '../../web/src/thing';\nexport const y = x;\n",
        'apps/web/src/thing.ts': 'export const x = 1;\n',
      }),
    ).toContain('apps-are-independent');
    expect(
      await ruleViolations({
        'packages/ui/src/index.ts': "import { x } from '../../../apps/web/src/thing';\nexport const y = x;\n",
        'apps/web/src/thing.ts': 'export const x = 1;\n',
      }),
    ).toContain('packages-not-to-apps');
  });

  it('enforces package layering: contracts and ui are leaves, the API shares only contracts', async () => {
    const app = { 'packages/app/src/index.ts': 'export const x = 1;\n' };
    expect(
      await ruleViolations({ ...app, 'packages/contracts/src/index.ts': "import { x } from '../../app/src/index';\nexport const y = x;\n" }),
    ).toContain('contracts-is-a-leaf');
    expect(
      await ruleViolations({ ...app, 'packages/ui/src/index.ts': "import { x } from '../../app/src/index';\nexport const y = x;\n" }),
    ).toContain('ui-is-presentational');
    expect(
      await ruleViolations({ ...app, 'apps/api/src/core/x.ts': "import { x } from '../../../../packages/app/src/index';\nexport const y = x;\n" }),
    ).toContain('api-uses-contracts-only');
  });

  it('allows the shared app to use contracts and ui', async () => {
    expect(
      await ruleViolations({
        'packages/app/src/index.ts': "import { a } from '../../contracts/src/index';\nimport { b } from '../../ui/src/index';\nexport const y = [a, b];\n",
        'packages/contracts/src/index.ts': 'export const a = 1;\n',
        'packages/ui/src/index.ts': 'export const b = 1;\n',
      }),
    ).toEqual([]);
  });
});

describe('source rules (scripts/check-boundaries.mjs)', () => {
  const server = (files: Array<[string, string]>) => serverViolations(files).map((v) => v.split(':')[0]);
  const client = (files: Array<[string, string]>) => clientViolations(files).map((v) => v.split(':')[0]);

  it('forbids client components in the API', () => {
    expect(server([['app/x/form.tsx', "'use client';\nexport const x = 1;\n"]])).toEqual(['api-has-no-client-components']);
  });

  it('forbids reading businessId from a tenant context outside core', () => {
    expect(server([['modules/customers/server/service.ts', 'export const f = (ctx) => ctx.businessId;\n']])).toEqual(['tenant-id-outside-core']);
    expect(server([['app/api/v1/x/route.ts', 'const { businessId } = tenant;\n']])).toEqual(['tenant-id-outside-core']);
    expect(server([['core/tenant/index.ts', 'export const f = (ctx) => ctx.businessId;\n']])).toEqual([]);
  });

  it('forbids hard-coded region names in the API and the clients', () => {
    expect(server([['core/config/env.ts', "const r = 'us-east-1';\n"]])).toEqual(['no-region-literals']);
    expect(server([['core/config/regions.ts', "const r = 'us-east-1';\n"]])).toEqual([]);
    expect(client([['apps/web/src/main.ts', "const r = 'iad1';\n"]])).toEqual(['no-region-literals']);
  });

  it('forbids clients importing server code by any route', () => {
    expect(client([['apps/desktop/src/main.ts', "import { db } from '@business-os/api/src/core/db';\n"]])).toEqual(['client-imports-server']);
    expect(client([['packages/app/src/x.ts', "import { db } from '../../../apps/api/src/core/db';\n"]])).toEqual(['client-imports-server']);
    expect(client([['packages/app/src/x.ts', "const pg = await import('pg');\n"]])).toEqual(['client-imports-server']);
    expect(client([['apps/web/src/x.ts', "import 'server-only';\n"]])).toEqual(['client-imports-server']);
    expect(client([['packages/app/src/x.ts', "import { App } from '@business-os/ui';\n"]])).toEqual([]);
  });

  it('forbids database configuration in client code', () => {
    expect(client([['apps/desktop/src/x.ts', 'const url = import.meta.env.DATABASE_URL;\n']])).toEqual(['client-database-config']);
    expect(client([['packages/app/src/x.ts', "const url = 'postgresql://u:p@h/db';\n"]])).toEqual(['client-database-config']);
  });

  it('passes on the real repository', () => {
    expect(checkRepository(resolve(__dirname, '../..')).errors).toEqual([]);
  });
});
