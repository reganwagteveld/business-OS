import { describe, expect, it, vi } from 'vitest';
import { createBusinessFlow, memoryStorage, resolveWorkspace, type AuthClient, type BusinessContext, type BusinessSummary, type Outcome, type TenancyClient } from '../src';
import type { SessionCheck } from '../src/api/auth';

const user = { id: '0b8f9a9e-2f1c-4c7e-9a52-0c7f6d1b2a10', email: 'a@example.com', name: 'A', emailVerified: true };
const biz = (slug: string, role: BusinessSummary['role'] = 'OWNER'): BusinessSummary => ({ slug, name: slug.toUpperCase(), role });
const ctx = (slug: string): BusinessContext => ({
  business: { slug, name: slug.toUpperCase(), countryCode: 'US', timeZone: 'America/Chicago', locale: 'en-US', currency: 'USD' },
  membership: { id: '1b8f9a9e-2f1c-4c7e-9a52-0c7f6d1b2a11', role: 'OWNER', permissions: ['business:read'] },
});

function deps(opts: {
  session?: SessionCheck;
  list?: Outcome<BusinessSummary[]>;
  context?: (slug: string) => Outcome<BusinessContext>;
  storage?: ReturnType<typeof memoryStorage>;
  preferredSlug?: string | null;
}) {
  const auth = { session: vi.fn(async () => opts.session ?? ({ kind: 'signed-in', user } as SessionCheck)) } as unknown as AuthClient;
  const tenancy: TenancyClient = {
    listBusinesses: vi.fn(async () => opts.list ?? ({ kind: 'ok', data: [] } as Outcome<BusinessSummary[]>)),
    businessContext: vi.fn(async (slug: string) => (opts.context ? opts.context(slug) : ({ kind: 'ok', data: ctx(slug) } as Outcome<BusinessContext>))),
    createBusiness: vi.fn(async () => ({ kind: 'failed', status: 500 }) as Outcome<{ slug: string }>),
  };
  const storage = opts.storage ?? memoryStorage();
  return { auth, tenancy, storage, preferredSlug: opts.preferredSlug };
}

describe('workspace resolution', () => {
  it('signed out: a first visit is not an expired session', async () => {
    expect(await resolveWorkspace(deps({ session: { kind: 'signed-out' } }))).toEqual({ kind: 'signed-out', expired: false });
  });

  it('signed out after having a session is reported as expired', async () => {
    const d = deps({ session: { kind: 'signed-out' }, storage: memoryStorage({ hadSession: true }) });
    expect(await resolveWorkspace(d)).toEqual({ kind: 'signed-out', expired: true });
  });

  it('a session that ends between the two calls is expired too', async () => {
    expect(await resolveWorkspace(deps({ list: { kind: 'unauthenticated' } }))).toEqual({ kind: 'signed-out', expired: true });
    const d = deps({ list: { kind: 'ok', data: [biz('alpha')] }, context: () => ({ kind: 'unauthenticated' }) });
    expect(await resolveWorkspace(d)).toEqual({ kind: 'signed-out', expired: true });
  });

  it('offline or unreachable is NOT signed out, at any step', async () => {
    expect(await resolveWorkspace(deps({ session: { kind: 'unreachable' }, storage: memoryStorage({ hadSession: true }) }))).toEqual({ kind: 'unreachable' });
    expect(await resolveWorkspace(deps({ list: { kind: 'unreachable' } }))).toEqual({ kind: 'unreachable' });
    expect(await resolveWorkspace(deps({ list: { kind: 'ok', data: [biz('alpha')] }, context: () => ({ kind: 'unreachable' }) }))).toEqual({ kind: 'unreachable' });
  });

  it('server and contract errors are "failed", never signed out or empty', async () => {
    expect(await resolveWorkspace(deps({ session: { kind: 'failed' } }))).toEqual({ kind: 'failed' });
    expect(await resolveWorkspace(deps({ list: { kind: 'failed', status: 503 } }))).toEqual({ kind: 'failed' });
    expect(await resolveWorkspace(deps({ list: { kind: 'invalid' } }))).toEqual({ kind: 'failed' });
    expect(await resolveWorkspace(deps({ list: { kind: 'ok', data: [biz('alpha')] }, context: () => ({ kind: 'invalid' }) }))).toEqual({ kind: 'failed' });
  });

  it('an unverified email goes to the verification screen and never lists businesses', async () => {
    const d = deps({ session: { kind: 'signed-in', user: { ...user, emailVerified: false } } });
    expect((await resolveWorkspace(d)).kind).toBe('unverified');
    expect(d.tenancy.listBusinesses).not.toHaveBeenCalled();
    expect((await resolveWorkspace(deps({ list: { kind: 'unverified' } }))).kind).toBe('unverified');
  });

  it('no businesses: honest empty state, and a stale saved slug is forgotten', async () => {
    const storage = memoryStorage({ slug: 'old' });
    expect(await resolveWorkspace(deps({ storage }))).toEqual({ kind: 'no-workspace', user });
    expect(storage.getSlug()).toBeNull();
  });

  it('one business: enters it directly using the server context', async () => {
    const storage = memoryStorage();
    const d = deps({ list: { kind: 'ok', data: [biz('acme')] }, storage });
    const result = await resolveWorkspace(d);
    expect(result).toMatchObject({ kind: 'ready', context: ctx('acme') });
    expect(d.tenancy.businessContext).toHaveBeenCalledWith('acme', undefined);
    expect(storage.getSlug()).toBe('acme');
  });

  it('several businesses and no saved choice: shows the picker without loading any context', async () => {
    const d = deps({ list: { kind: 'ok', data: [biz('alpha'), biz('bravo')] } });
    expect(await resolveWorkspace(d)).toMatchObject({ kind: 'pick', businesses: [biz('alpha'), biz('bravo')] });
    expect(d.tenancy.businessContext).not.toHaveBeenCalled();
  });

  it('several businesses with a valid saved slug: re-opens it (checked against the membership list)', async () => {
    const d = deps({ list: { kind: 'ok', data: [biz('alpha'), biz('bravo')] }, storage: memoryStorage({ slug: 'bravo' }) });
    expect(await resolveWorkspace(d)).toMatchObject({ kind: 'ready', context: ctx('bravo') });
  });

  it('a saved slug the person no longer belongs to is ignored and cleared, never used', async () => {
    const storage = memoryStorage({ slug: 'gone' });
    const d = deps({ list: { kind: 'ok', data: [biz('alpha'), biz('bravo')] }, storage });
    expect((await resolveWorkspace(d)).kind).toBe('pick');
    expect(d.tenancy.businessContext).not.toHaveBeenCalledWith('gone', expect.anything());
    expect(storage.getSlug()).toBeNull();
    // with a single business left, the stale slug is replaced by the real one
    const one = deps({ list: { kind: 'ok', data: [biz('alpha')] }, storage: memoryStorage({ slug: 'gone' }) });
    expect(await resolveWorkspace(one)).toMatchObject({ kind: 'ready', context: ctx('alpha') });
  });

  it('an explicit choice is honoured only if the server lists it', async () => {
    const list = { kind: 'ok', data: [biz('alpha'), biz('bravo')] } as Outcome<BusinessSummary[]>;
    expect(await resolveWorkspace(deps({ list, preferredSlug: 'bravo' }))).toMatchObject({ kind: 'ready', context: ctx('bravo') });
    const forged = deps({ list, preferredSlug: 'someone-elses' });
    expect((await resolveWorkspace(forged)).kind).toBe('pick');
    expect(forged.tenancy.businessContext).not.toHaveBeenCalled();
  });

  it('membership that disappears between calls: clears the choice and looks again once', async () => {
    const storage = memoryStorage({ slug: 'alpha' });
    let first = true;
    const d = deps({
      list: { kind: 'ok', data: [biz('alpha'), biz('bravo')] },
      storage,
      context: (slug) => {
        if (slug === 'alpha' && first) {
          first = false;
          return { kind: 'not_found' };
        }
        return { kind: 'ok', data: ctx(slug) };
      },
    });
    expect((await resolveWorkspace(d)).kind).toBe('pick');
    expect(storage.getSlug()).toBeNull();
    // and it gives up (failed) rather than looping if the server keeps answering 404
    const loop = deps({ list: { kind: 'ok', data: [biz('alpha')] }, context: () => ({ kind: 'not_found' }) });
    expect(await resolveWorkspace(loop)).toEqual({ kind: 'failed' });
  });

  it('forbidden business context is a failure, not a silent downgrade', async () => {
    const d = deps({ list: { kind: 'ok', data: [biz('alpha')] }, context: () => ({ kind: 'forbidden' }) });
    expect(await resolveWorkspace(d)).toEqual({ kind: 'failed' });
  });

  it('remembers that a session existed once the server confirms it', async () => {
    const storage = memoryStorage();
    await resolveWorkspace(deps({ storage }));
    expect(storage.hadSession()).toBe(true);
  });
});

describe('creating the first business', () => {
  const input = { name: 'Acme', slug: 'acme', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' };
  const tenancyWith = (create: () => Outcome<{ slug: string }>, list?: Outcome<BusinessSummary[]>) => {
    const t = deps({ list }).tenancy;
    (t.createBusiness as ReturnType<typeof vi.fn>).mockImplementation(async () => create());
    return t;
  };

  it('success opens the new business', async () => {
    expect(await createBusinessFlow(tenancyWith(() => ({ kind: 'ok', data: { slug: 'acme' } })), input)).toEqual({ kind: 'created', slug: 'acme' });
  });

  it('a slug conflict says so and offers the fix, without reading memberships', async () => {
    const t = tenancyWith(() => ({ kind: 'conflict' }));
    expect(await createBusinessFlow(t, input)).toEqual({ kind: 'rejected', message: 'That workspace address is already taken. Choose another.' });
    expect(t.listBusinesses).not.toHaveBeenCalled();
  });

  it('after an ambiguous network failure it re-reads memberships and treats an existing business as success (no duplicate)', async () => {
    const t = tenancyWith(() => ({ kind: 'unreachable' }), { kind: 'ok', data: [biz('acme')] });
    expect(await createBusinessFlow(t, input)).toEqual({ kind: 'created', slug: 'acme' });
    expect(t.createBusiness).toHaveBeenCalledTimes(1);
  });

  it('after a network failure with no such business it reports offline so the person can retry', async () => {
    const t = tenancyWith(() => ({ kind: 'unreachable' }), { kind: 'ok', data: [] });
    expect(await createBusinessFlow(t, input)).toMatchObject({ kind: 'rejected', message: expect.stringContaining('Cannot reach Business OS') });
  });

  it('an ended session is reported as such; server validation and rate limits are passed on plainly', async () => {
    expect(await createBusinessFlow(tenancyWith(() => ({ kind: 'unauthenticated' })), input)).toEqual({ kind: 'session-ended' });
    expect(await createBusinessFlow(tenancyWith(() => ({ kind: 'invalid_input', message: 'Use a valid currency' })), input)).toEqual({ kind: 'rejected', message: 'Use a valid currency' });
    expect(await createBusinessFlow(tenancyWith(() => ({ kind: 'rate_limited' })), input)).toMatchObject({ kind: 'rejected', message: expect.stringContaining('Too many') });
    expect(await createBusinessFlow(tenancyWith(() => ({ kind: 'failed', status: 500 })), input)).toMatchObject({ kind: 'rejected' });
  });
});
