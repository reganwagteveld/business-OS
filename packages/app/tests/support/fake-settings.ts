import type { BusinessProfileData } from '../../src/api/settings';

/** A stand-in for the business profile API (A2-A): strict versioned PATCH, 409 stale, per-business records, call log. */
export interface FakeSettings {
  fetch: typeof fetch;
  profiles: Record<string, BusinessProfileData>;
  calls: { method: string; path: string; body?: unknown }[];
  /** The next requests answer with these (consumed in order), for loading, error and offline states. */
  failNext: (answers: ('network' | number)[]) => void;
  /** Simulates another person saving first: bumps the stored version and applies `change`. */
  editElsewhere: (slug: string, change: Partial<BusinessProfileData>) => void;
  /** Holds GET responses until released, to observe the loading state. */
  hold: () => () => void;
}

export function profile(slug: string, over: Partial<BusinessProfileData> = {}): BusinessProfileData {
  return {
    slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, legalName: `${slug} Plumbing Pty Ltd`, tradingName: null, contactEmail: `office@${slug}.example`, contactPhone: null, website: null,
    address: { line1: '1 Hay Street', line2: null, city: 'Perth', region: 'WA', postalCode: '6000', countryCode: 'AU' },
    countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD', fiscalYearStartMonth: 7, homeRegion: 'ap-southeast', version: 1, updatedAt: '2026-11-01T00:00:00.000Z', ...over,
  };
}

export function createFakeSettings(slugs: string[] = ['alpha', 'beta']): FakeSettings {
  const profiles: Record<string, BusinessProfileData> = Object.fromEntries(slugs.map((s) => [s, profile(s)]));
  const calls: FakeSettings['calls'] = [];
  let failures: ('network' | number)[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const match = /^\/api\/v1\/b\/([^/]+)\/business$/.exec(url.pathname);
    if (!match) return json(404, { error: 'not_found' });
    if (method === 'GET' && gate) await gate;
    const failure = failures.shift();
    if (failure === 'network') throw new TypeError('network down');
    if (typeof failure === 'number') return json(failure, { error: failure === 403 ? 'forbidden' : 'server_error' });
    const current = profiles[match[1]!];
    if (!current) return json(404, { error: 'not_found' });
    if (method === 'GET') return json(200, { business: current });
    if (method === 'PATCH') {
      if (body.version !== current.version) return json(409, { error: 'stale' });
      const { address, ...rest } = body as { address?: Record<string, unknown> } & Record<string, unknown>;
      delete rest.version;
      const next: BusinessProfileData = { ...current, ...rest, address: { ...current.address, ...(address ?? {}) }, version: current.version + 1, updatedAt: '2026-11-17T09:00:00.000Z' };
      for (const key of ['legalName', 'tradingName', 'contactEmail', 'contactPhone', 'website'] as const) if (next[key] === '') next[key] = null;
      profiles[match[1]!] = next;
      return json(200, { business: next });
    }
    return json(405, { error: 'method_not_allowed' });
  }) as typeof fetch;

  return {
    fetch: fakeFetch, profiles, calls,
    failNext: (answers) => { failures = [...answers]; },
    editElsewhere: (slug, change) => { const p = profiles[slug]!; profiles[slug] = { ...p, ...change, version: p.version + 1 }; },
    hold: () => {
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { release?.(); gate = null; };
    },
  };
}
