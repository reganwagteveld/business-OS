/**
 * The search-index rehearsal must prove its target is disposable before it seeds, writes or migrates
 * (docs/search-index-migration.md §2; ChatGPT audit of PR #97, HIGH). These tests drive the guard with a
 * fake Neon control plane: every case that is not a verified local database or a verified temporary
 * rehearsal branch must refuse.
 */
import { describe, expect, it } from 'vitest';
import { endpointHost, RehearsalTargetError, verifyRehearsalTarget } from '../../scripts/lib/rehearsal-guard.mjs';

const NOW = new Date('2026-11-17T12:00:00Z');
const BRANCH = 'br-rehearsal-1';
const PROD = 'br-production-1';
const BRANCH_HOST = 'ep-rehearsal-abc.us-east-1.aws.neon.tech';
const PROD_HOST = 'ep-production-xyz.us-east-1.aws.neon.tech';
const NEON_ENV = { NEON_API_KEY: 'test-key', NEON_PROJECT_ID: 'proj-1', REHEARSAL_NEON_BRANCH_ID: BRANCH };

const urls = (host: string, overrides: Partial<Record<'owner' | 'app' | 'admin', string>> = {}) => ({
  owner: `postgresql://bos_owner:x@${host}/neondb`,
  app: `postgresql://bos_app:x@${host}/neondb`,
  admin: `postgresql://neondb_owner:x@${host}/neondb`,
  ...overrides,
});

interface FakeBranch { id: string; name: string; default?: boolean | null; primary?: boolean; protected?: boolean | null | string; created_at: string; hosts: string[] }
const rehearsalBranch = (over: Partial<FakeBranch> = {}): FakeBranch => ({
  id: BRANCH, name: 'rehearsal-search-indexes-20261117', default: false, protected: false, created_at: '2026-11-17T08:00:00Z', hosts: [BRANCH_HOST], ...over,
});
const productionBranch: FakeBranch = { id: PROD, name: 'production', default: true, protected: true, created_at: '2026-11-01T00:00:00Z', hosts: [PROD_HOST] };

function fakeNeon(branches: FakeBranch[], opts: { failWith?: number; throws?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (opts.throws) throw new Error('network down');
    if (opts.failWith) return { ok: false, status: opts.failWith, json: async () => ({}) };
    const path = url.replace('https://console.neon.tech/api/v2/projects/proj-1', '');
    const strip = (b: FakeBranch) => Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'hosts'));
    let body: unknown = {};
    const endpoints = path.match(/^\/branches\/([^/]+)\/endpoints$/);
    const one = path.match(/^\/branches\/([^/]+)$/);
    if (endpoints) body = { endpoints: (branches.find((b) => b.id === decodeURIComponent(endpoints[1]!))?.hosts ?? []).map((host) => ({ host })) };
    else if (one) {
      const b = branches.find((x) => x.id === decodeURIComponent(one[1]!));
      if (!b) return { ok: false, status: 404, json: async () => ({}) };
      body = { branch: strip(b) };
    } else if (path === '/branches') body = { branches: branches.map(strip) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

async function refusal(input: Parameters<typeof verifyRehearsalTarget>[0]): Promise<string> {
  try {
    await verifyRehearsalTarget({ now: NOW, ...input });
  } catch (error) {
    expect(error).toBeInstanceOf(RehearsalTargetError);
    return (error as Error).message;
  }
  throw new Error('expected the guard to refuse');
}

describe('rehearsal target guard: accepted targets', () => {
  it('accepts a local database without calling Neon', async () => {
    const neon = fakeNeon([]);
    await expect(verifyRehearsalTarget({ urls: urls('localhost:5432'), env: {}, fetchImpl: neon.fetchImpl, now: NOW })).resolves.toEqual({ mode: 'local' });
    expect(neon.calls).toEqual([]);
  });

  it('tolerates a few minutes of clock skew on a just-created branch', async () => {
    const neon = fakeNeon([productionBranch, rehearsalBranch({ created_at: '2026-11-17T12:03:00Z' })]);
    await expect(verifyRehearsalTarget({ urls: urls(BRANCH_HOST), env: NEON_ENV, fetchImpl: neon.fetchImpl, now: NOW })).resolves.toMatchObject({ mode: 'neon-branch' });
  });

  it('accepts a verified temporary rehearsal branch, through its pooled host too', async () => {
    const neon = fakeNeon([productionBranch, rehearsalBranch()]);
    const pooled = 'ep-rehearsal-abc-pooler.us-east-1.aws.neon.tech';
    await expect(
      verifyRehearsalTarget({ urls: urls(BRANCH_HOST, { app: `postgresql://bos_app:x@${pooled}/neondb` }), env: NEON_ENV, fetchImpl: neon.fetchImpl, now: NOW }),
    ).resolves.toEqual({ mode: 'neon-branch', branchName: 'rehearsal-search-indexes-20261117' });
    expect(endpointHost(pooled)).toBe(BRANCH_HOST);
  });
});

describe('rehearsal target guard: refusals', () => {
  it('refuses the production host even when no production URL is set in the shell', async () => {
    const neon = fakeNeon([productionBranch, rehearsalBranch()]);
    expect(await refusal({ urls: urls(PROD_HOST), env: NEON_ENV, fetchImpl: neon.fetchImpl })).toMatch(/not an endpoint of the named branch/);
  });

  it('refuses when the named branch is the default branch, even if the host is its endpoint', async () => {
    const neon = fakeNeon([productionBranch]);
    expect(await refusal({ urls: urls(PROD_HOST), env: { ...NEON_ENV, REHEARSAL_NEON_BRANCH_ID: PROD }, fetchImpl: neon.fetchImpl })).toMatch(/default \(production\) branch/);
  });

  it('refuses a rehearsal-named branch whose endpoint is shared with production', async () => {
    const neon = fakeNeon([{ ...productionBranch, hosts: [BRANCH_HOST] }, rehearsalBranch()]);
    expect(await refusal({ urls: urls(BRANCH_HOST), env: NEON_ENV, fetchImpl: neon.fetchImpl })).toMatch(/endpoint of the production branch/);
  });

  it('refuses the host of a production URL set in the shell, before calling Neon', async () => {
    const neon = fakeNeon([productionBranch, rehearsalBranch()]);
    const env = { ...NEON_ENV, MIGRATION_DATABASE_URL: `postgresql://bos_owner:x@${BRANCH_HOST}/neondb` };
    expect(await refusal({ urls: urls(BRANCH_HOST), env, fetchImpl: neon.fetchImpl })).toMatch(/host of MIGRATION_DATABASE_URL/);
    expect(neon.calls).toEqual([]);
  });

  it('refuses a remote host with no Neon credentials (no production environment to compare against)', async () => {
    expect(await refusal({ urls: urls(BRANCH_HOST), env: {} })).toMatch(/needs NEON_API_KEY/);
  });

  it('refuses a branch that is protected, wrongly named, too old, undated, dated in the future, or missing its default or protection flag', async () => {
    for (const [over, pattern] of [
      [{ protected: true }, /protected/],
      [{ name: 'production-copy' }, /not a temporary rehearsal branch/],
      [{ created_at: '2026-11-01T00:00:00Z' }, /older than/],
      [{ created_at: '' }, /older than|no creation time/],
      [{ created_at: '2026-11-17T12:10:00Z' }, /in the future/],
      [{ protected: undefined }, /protection flag is missing/],
      [{ protected: null }, /protection flag is missing/],
      [{ protected: 'false' }, /protection flag is missing/],
      [{ default: undefined }, /default flag is missing/],
      [{ default: null }, /default flag is missing/],
    ] as const) {
      const neon = fakeNeon([productionBranch, rehearsalBranch(over)]);
      expect(await refusal({ urls: urls(BRANCH_HOST), env: NEON_ENV, fetchImpl: neon.fetchImpl })).toMatch(pattern);
    }
  });

  it('refuses a wrong or unknown branch id', async () => {
    const other = rehearsalBranch({ id: 'br-other', hosts: ['ep-other.us-east-1.aws.neon.tech'] });
    const neon = fakeNeon([productionBranch, rehearsalBranch(), other]);
    expect(await refusal({ urls: urls(BRANCH_HOST), env: { ...NEON_ENV, REHEARSAL_NEON_BRANCH_ID: 'br-other' }, fetchImpl: neon.fetchImpl })).toMatch(/not an endpoint of the named branch/);
    expect(await refusal({ urls: urls(BRANCH_HOST), env: { ...NEON_ENV, REHEARSAL_NEON_BRANCH_ID: 'br-missing' }, fetchImpl: neon.fetchImpl })).toMatch(/answered 404/);
  });

  it('fails closed when the Neon API errors or is unreachable', async () => {
    expect(await refusal({ urls: urls(BRANCH_HOST), env: NEON_ENV, fetchImpl: fakeNeon([], { failWith: 401 }).fetchImpl })).toMatch(/answered 401/);
    expect(await refusal({ urls: urls(BRANCH_HOST), env: NEON_ENV, fetchImpl: fakeNeon([], { throws: true }).fetchImpl })).toMatch(/could not be reached/);
  });

  it('refuses mismatched role URLs: different hosts, databases, shared roles, mixed local and remote', async () => {
    const neon = fakeNeon([productionBranch, rehearsalBranch()]).fetchImpl;
    const cases: [Partial<Record<'owner' | 'app' | 'admin', string>>, RegExp][] = [
      [{ admin: `postgresql://neondb_owner:x@${PROD_HOST}/neondb` }, /different hosts/],
      [{ app: `postgresql://bos_app:x@${BRANCH_HOST}/otherdb` }, /different databases/],
      [{ app: `postgresql://bos_owner:x@${BRANCH_HOST}/neondb` }, /app role/],
      [{ admin: `postgresql://bos_app:x@${BRANCH_HOST}/neondb` }, /app role/],
    ];
    for (const [over, pattern] of cases) {
      expect(await refusal({ urls: urls(BRANCH_HOST, over), env: NEON_ENV, fetchImpl: neon })).toMatch(pattern);
    }
    expect(await refusal({ urls: urls('localhost:5432', { admin: `postgresql://postgres:x@${BRANCH_HOST}/neondb` }), env: NEON_ENV, fetchImpl: neon })).toMatch(/different hosts/);
  });

  it('refuses a missing or malformed URL', async () => {
    expect(await refusal({ urls: { owner: 'postgresql://a@localhost/db', app: undefined, admin: 'postgresql://c@localhost/db' }, env: {} })).toMatch(/REHEARSAL_APP_DATABASE_URL is not set/);
    expect(await refusal({ urls: urls('localhost', { owner: 'https://localhost/db' }), env: {} })).toMatch(/not a PostgreSQL URL/);
    expect(await refusal({ urls: urls('localhost', { owner: 'postgresql://bos_owner@localhost' }), env: {} })).toMatch(/names no database/);
  });
});
