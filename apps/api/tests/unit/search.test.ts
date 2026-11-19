/**
 * Global search GS1-A unit, contract and source-rule tests (docs/global-search-gs1.md §14): the normaliser,
 * the tsquery text, cursors, the enablement constant and what can reach search while it is disabled, the
 * reviewed field lists, the index declarations, and the source rules for search providers.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SearchRequest, SearchResolveRequest, SearchResult, SearchType } from '@business-os/contracts';
import { decodeSearchCursor, encodeSearchCursor, normalizeQuery, SEARCH_API_ENABLED, SEARCH_INDEXES, SEARCH_PROVIDERS, searchApiEnabled, toTsquery } from '@/modules/search';

process.env.AUTH_SECRET ??= 'unit-test-only-auth-secret-0123456789abcdef';
// The cursor HMAC reads AUTH_SECRET through getEnv(), which validates the whole server environment. CI sets the
// rest; these test-only values let `pnpm test` pass on a fresh checkout too (never a real database: nothing connects).
process.env.DATABASE_URL ??= 'postgresql://unit:test@localhost:5432/unit_test_only';
process.env.AUTH_DATABASE_URL ??= 'postgresql://unit:test@localhost:5432/unit_test_only';
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.REGION ??= 'unit-test';
process.env.DATABASE_REGION ??= process.env.REGION;

const SRC = resolve(__dirname, '../../src');
const MIGRATIONS = resolve(__dirname, '../../prisma/migrations');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const sources = files(SRC).map((path) => [relative(SRC, path).split('\\').join('/'), readFileSync(path, 'utf8')] as const);

describe('enablement', () => {
  it('ships disabled: the routes answer 404 until a reviewed PR flips the constant (GS2 §12.1)', () => {
    expect(SEARCH_API_ENABLED).toBe(false);
    const saved = process.env.SEARCH_API_TEST_ENABLE;
    delete process.env.SEARCH_API_TEST_ENABLE;
    expect(searchApiEnabled()).toBe(false);
    process.env.SEARCH_API_TEST_ENABLE = '1';
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    expect(searchApiEnabled()).toBe(false); // the test opt-in never works outside the test runner
    env.NODE_ENV = nodeEnv;
    if (saved === undefined) delete process.env.SEARCH_API_TEST_ENABLE;
    else process.env.SEARCH_API_TEST_ENABLE = saved;
  });
});

describe('while disabled, nothing else can reach search', () => {
  it('only the two gated routes call the search service', () => {
    const callers = sources
      .filter(([name]) => !name.startsWith('modules/search/'))
      .filter(([, text]) => /\b(runSearch|resolveRecords)\b/.test(text))
      .map(([name]) => name);
    expect(callers.sort()).toEqual(['app/api/v1/b/[slug]/search/resolve/route.ts', 'app/api/v1/b/[slug]/search/route.ts']);
    for (const name of callers) {
      const text = sources.find(([n]) => n === name)![1];
      expect(text).toMatch(/available: searchApiEnabled/);
    }
  });

  it('search code starts no timers, background work, outbound calls or jobs, and reads no environment flag', () => {
    const searchFiles = sources.filter(([name]) => /^modules\/[^/]+\/server\/search\.ts$/.test(name) || name.startsWith('modules/search/') || name === 'core/search/index.ts');
    const effects = /\b(setTimeout|setInterval|setImmediate|queueMicrotask|fetch|after|waitUntil|cron|enqueue|sendEmail|webhook)\s*\(/;
    expect(searchFiles.filter(([, text]) => effects.test(text)).map(([n]) => n)).toEqual([]);
    // The only environment read is the test-runner opt-in, which needs NODE_ENV=test.
    expect(searchFiles.filter(([, text]) => /process\.env/.test(text)).map(([n]) => n)).toEqual(['modules/search/server/availability.ts']);
  });
});

describe('normaliser (§9.1)', () => {
  it('normalises Unicode and whitespace, and enables the word arm only from 3 characters', () => {
    expect(normalizeQuery('  Kelp \t  &\n Co ')).toEqual({ q: 'Kelp & Co', tsquery: "'Kelp':* & 'Co':*" });
    expect(normalizeQuery('ke')).toEqual({ q: 'ke', tsquery: null });
    expect(normalizeQuery('Jose\u0301')).toEqual({ q: 'José', tsquery: "'José':*" });
    expect(normalizeQuery('%%%')).toEqual({ q: '%%%', tsquery: null });
    expect(normalizeQuery('INV-0042').tsquery).toBe("'INV':* & '0042':*");
    expect(normalizeQuery('東京都 支店').tsquery).toBe("'東京都':* & '支店':*");
  });

  it('rejects out-of-range input', () => {
    for (const q of ['k', ' k ', 'x'.repeat(101), 'a b c d e f g h i']) expect(() => normalizeQuery(q)).toThrow();
  });

  it('never puts an operator, quote or backslash into the tsquery text, for any input', () => {
    const alphabet = ["'", '"', '\\', '&', '|', '!', '(', ')', ':', '*', '<', '-', '>', ' ', '%', '_', ';', 'a', 'Z', '7', 'é', '中', '\u200b', 'ｋ'];
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 3000; i++) {
      const length = 2 + (next() % 30);
      const raw = Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
      let result: ReturnType<typeof normalizeQuery>;
      try {
        result = normalizeQuery(raw);
      } catch {
        continue;
      }
      if (result.tsquery === null) continue;
      const tokens = result.tsquery.split(' & ');
      for (const token of tokens) expect(token).toMatch(/^'[\p{L}\p{N}]+':\*$/u);
      expect(tokens.length).toBeLessThanOrEqual(8);
    }
    expect(() => toTsquery(["a'b"])).toThrow();
    expect(() => toTsquery(['a&b'])).toThrow();
  });
});

describe('cursor', () => {
  const binding = { businessId: '00000000-0000-4000-8000-000000000001', type: 'customer' as const, q: 'kelp', includeArchived: false };
  const position = { tier: 2, demote: 0, sortKey: 'kelp & co', id: '00000000-0000-4000-8000-0000000000aa' };

  it('round-trips and is bound to business, type, query and the archived toggle', () => {
    const cursor = encodeSearchCursor(binding, position);
    expect(decodeSearchCursor(binding, cursor)).toEqual(position);
    for (const other of [
      { ...binding, businessId: '00000000-0000-4000-8000-000000000002' }, { ...binding, type: 'contact' as const },
      { ...binding, q: 'kelpie' }, { ...binding, includeArchived: true },
    ]) expect(() => decodeSearchCursor(other, cursor)).toThrow();
  });

  it('rejects tampered or malformed cursors', () => {
    const cursor = encodeSearchCursor(binding, position);
    const [, mac] = cursor.split('.');
    const forged = `${Buffer.from(JSON.stringify([1, 0, 'a', position.id])).toString('base64url')}.${mac}`;
    for (const bad of [forged, 'abc', `${cursor}.x`, cursor.slice(0, -2), '.', `${cursor.split('.')[0]}.`]) {
      expect(() => decodeSearchCursor(binding, bad)).toThrow();
    }
  });
});

describe('contract (§7, §8)', () => {
  it('has no Scheduling types and rejects unknown fields', () => {
    expect(SearchType.options).not.toContain('event');
    expect(SearchType.options).not.toContain('resource');
    expect(SearchRequest.safeParse({ q: 'kelp', businessId: 'x' }).success).toBe(false);
    expect(SearchRequest.safeParse({ q: 'kelp', cursor: 'abc' }).success).toBe(false);
    expect(SearchRequest.safeParse({ q: 'kelp', types: ['customer'], cursor: 'abc' }).success).toBe(true);
    expect(SearchResolveRequest.safeParse({ items: [{ type: 'customer', id: '00000000-0000-4000-8000-000000000001', title: 'x' }] }).success).toBe(false);
  });

  it('carries exactly six result fields, strictly (GS2 §4.5)', () => {
    expect(Object.keys(SearchResult.shape).sort()).toEqual(['badges', 'id', 'route', 'subtitle', 'title', 'type']);
    const base = { type: 'customer', id: '00000000-0000-4000-8000-000000000001', title: 'Kelp', subtitle: null, badges: [], route: { zone: 'customers', target: 'x' } };
    expect(SearchResult.safeParse(base).success).toBe(true);
    expect(SearchResult.safeParse({ ...base, amount: '100.00' }).success).toBe(false);
    expect(SearchResult.safeParse({ ...base, badges: ['vip'] }).success).toBe(false);
    expect(SearchResult.safeParse({ ...base, title: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('providers (§4.1, §6.4)', () => {
  it('pins every provider’s permission key and reviewed field lists', () => {
    expect(SEARCH_PROVIDERS.map((p) => ({ type: p.type, zone: p.zone, requires: p.requires, match: p.matchFields, result: p.resultFields }))).toMatchInlineSnapshot(`
      [
        {
          "match": [
            "display_name",
            "legal_name",
            "email",
          ],
          "requires": [
            "customers:read",
          ],
          "result": [
            "display_name",
            "legal_name",
            "email",
            "archived_at",
          ],
          "type": "customer",
          "zone": "customers",
        },
        {
          "match": [
            "display_name",
            "email",
          ],
          "requires": [
            "customers:read",
          ],
          "result": [
            "display_name",
            "customer.display_name",
            "archived_at",
          ],
          "type": "contact",
          "zone": "customers",
        },
        {
          "match": [
            "title",
          ],
          "requires": [
            "sales:read",
          ],
          "result": [
            "title",
            "status",
            "stage.name",
            "customer.display_name (customers:read only)",
            "archived_at",
          ],
          "type": "opportunity",
          "zone": "sales",
        },
        {
          "match": [
            "name",
          ],
          "requires": [
            "projects:read",
          ],
          "result": [
            "name",
            "status",
            "customer.display_name (customers:read only)",
            "archived_at",
          ],
          "type": "project",
          "zone": "projects",
        },
        {
          "match": [
            "title",
          ],
          "requires": [
            "projects:read",
          ],
          "result": [
            "title",
            "status",
            "project.name",
            "archived_at",
          ],
          "type": "task",
          "zone": "projects",
        },
        {
          "match": [
            "number",
            "customer.display_name",
          ],
          "requires": [
            "finance:read",
          ],
          "result": [
            "number",
            "status",
            "customer.display_name",
            "issue_date",
          ],
          "type": "quote",
          "zone": "finance",
        },
        {
          "match": [
            "number",
            "customer.display_name",
          ],
          "requires": [
            "finance:read",
          ],
          "result": [
            "number",
            "status",
            "customer.display_name",
            "due_date (else issue_date)",
          ],
          "type": "invoice",
          "zone": "finance",
        },
        {
          "match": [
            "number",
            "customer.display_name",
          ],
          "requires": [
            "finance:read",
          ],
          "result": [
            "number",
            "status",
            "customer.display_name",
            "issue_date",
          ],
          "type": "credit_note",
          "zone": "finance",
        },
        {
          "match": [
            "name",
            "code",
          ],
          "requires": [
            "finance:read",
          ],
          "result": [
            "name",
            "code",
            "type",
            "status",
            "archived_at",
          ],
          "type": "catalog_item",
          "zone": "finance",
        },
        {
          "match": [
            "given_name",
            "family_name",
            "preferred_name",
            "employee_number",
            "work_email",
            "job_title",
          ],
          "requires": [
            "people:read",
          ],
          "result": [
            "given_name",
            "preferred_name",
            "family_name",
            "job_title",
            "status",
            "department.name",
          ],
          "type": "employee",
          "zone": "people",
        },
      ]
    `);
    expect(SEARCH_PROVIDERS.map((p) => p.type)).toEqual(SearchType.options);
  });

  it('declares every index the migration creates, verbatim, and nothing else', () => {
    const migration = readFileSync(join(MIGRATIONS, '20261206000000_search_indexes', 'migration.sql'), 'utf8');
    const created = migration.split('\n').filter((l) => l.startsWith('CREATE INDEX'));
    expect(created).toEqual(SEARCH_INDEXES.map((i) => i.statement));
    expect(SEARCH_INDEXES).toHaveLength(22);
    expect(new Set(SEARCH_INDEXES.map((i) => i.name)).size).toBe(SEARCH_INDEXES.length);
    // Additive only: no table, column, policy, grant, extension or function change.
    expect(migration.replace(/^--.*$/gm, '')).not.toMatch(/\b(ALTER|DROP|GRANT|REVOKE|EXTENSION|FUNCTION|POLICY|CONCURRENTLY)\b/);
    // No other migration creates a search index.
    const creating = readdirSync(MIGRATIONS)
      .filter((d) => statSync(join(MIGRATIONS, d)).isDirectory())
      .filter((d) => /_search_\w*idx/.test(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8')));
    expect(creating).toEqual(['20261206000000_search_indexes']);
  });
});

describe('source rules (§6.4, §14)', () => {
  const providerFiles = sources.filter(([name]) => /^modules\/[^/]+\/server\/search\.ts$/.test(name) || name.startsWith('modules/search/') || name === 'core/search/index.ts');

  it('covers every search source file', () => {
    expect(providerFiles.map(([n]) => n).sort()).toEqual([
      'core/search/index.ts', 'modules/customers/server/search.ts', 'modules/finance/server/search.ts', 'modules/people/server/search.ts',
      'modules/projects/server/search.ts', 'modules/sales/server/search.ts', 'modules/search/index.ts', 'modules/search/server/availability.ts',
      'modules/search/server/cursor.ts', 'modules/search/server/normalize.ts', 'modules/search/server/registry.ts', 'modules/search/server/service.ts',
    ]);
  });

  it('never references personal details, history, manager, leave, activity, message or mailbox tables', () => {
    const forbidden = /personal_|personalDetails|people_employee_personal_details|status_history|manager_assignments|leave_|activities|\bmessages\b|conversations|mail_|notes\b|description\b/;
    const offenders = providerFiles
      .map(([name, text]) => [name, text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')] as const) // comments may name what is excluded
      .filter(([, code]) => forbidden.test(code))
      .map(([name, code]) => `${name}: ${code.match(forbidden)![0]}`);
    expect(offenders).toEqual([]);
  });

  it('builds SQL only from tagged fragments: no unsafe raw queries, ILIKE or LIKE', () => {
    const offenders = providerFiles.filter(([, text]) => /\$queryRawUnsafe|\$executeRawUnsafe|\bI?LIKE\b|ts_headline/i.test(text.replace(/^\s*(\/\/|\*).*$/gm, ''))).map(([n]) => n);
    expect(offenders).toEqual([]);
  });

  it('never logs the request body, query or results', () => {
    const service = sources.find(([n]) => n === 'modules/search/server/service.ts')![1];
    const logs = service.match(/console\.\w+\([^;]*\)/g) ?? [];
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/console\.info\('\[search\]', JSON\.stringify\(\{ kind, outcome, ms: bucket/);
  });
});
