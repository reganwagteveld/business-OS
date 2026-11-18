import type { AccessModelData, BusinessProfileData, InvitationData, MemberData } from '../../src/api/settings';
import { ACCESS_MODEL } from './access-model';

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
  /** Team (A2-B) stand-in, per business. */
  members: Record<string, MemberData[]>;
  invitations: Record<string, InvitationData[]>;
  /** Behaviour switches for the next requests. */
  /** The signed-in person's membership id (the fake needs it for step-down, leave and hand-over). */
  setMe: (id: string) => void;
  options: { deliveryFails: boolean; resendTooSoon: boolean; showEmails: boolean };
  /** What `GET /access/roles` answers (A2-C): the real description by default; replace it to simulate drift. */
  access: { model: AccessModelData };
}

export function member(over: Partial<MemberData> & { id: string }): MemberData {
  return { userId: over.userId ?? crypto.randomUUID(), name: 'Member', role: 'MEMBER', status: 'ACTIVE', createdAt: '2026-10-01T00:00:00.000Z', suspendedAt: null, email: null, ...over };
}

export function profile(slug: string, over: Partial<BusinessProfileData> = {}): BusinessProfileData {
  return {
    slug, name: `${slug[0]!.toUpperCase()}${slug.slice(1)} Plumbing`, legalName: `${slug} Plumbing Pty Ltd`, tradingName: null, contactEmail: `office@${slug}.example`, contactPhone: null, website: null,
    address: { line1: '1 Hay Street', line2: null, city: 'Perth', region: 'WA', postalCode: '6000', countryCode: 'AU' },
    countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD', fiscalYearStartMonth: 7, homeRegion: 'ap-southeast', version: 1, updatedAt: '2026-11-01T00:00:00.000Z', ...over,
  };
}

export function createFakeSettings(slugs: string[] = ['alpha', 'beta'], seed: Record<string, MemberData[]> = {}): FakeSettings {
  const profiles: Record<string, BusinessProfileData> = Object.fromEntries(slugs.map((s) => [s, profile(s)]));
  const calls: FakeSettings['calls'] = [];
  const members: Record<string, MemberData[]> = Object.fromEntries(slugs.map((s) => [s, seed[s] ?? []]));
  const invitations: Record<string, InvitationData[]> = Object.fromEntries(slugs.map((s) => [s, []]));
  const options = { deliveryFails: false, resendTooSoon: false, showEmails: true };
  const access = { model: structuredClone(ACCESS_MODEL) };
  const conflict = (code: string) => json(409, { error: code });
  const activeOwners = (slug: string, except?: string) => members[slug]!.filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE' && m.id !== except).length;
  let failures: ('network' | number)[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const teamRoute = (slug: string, area: string, id: string | undefined, tail: string | undefined, method: string, body: Record<string, unknown> & { role?: string; status?: string }): Response => {
    const list = members[slug];
    if (!list) return json(404, { error: 'not_found' });
    const find = (mid?: string) => list.find((m) => m.id === mid);
    if (area === 'members' && !id) return json(200, { members: list.map((m) => (options.showEmails ? m : { ...m, email: null })) });
    if (area === 'members' && id && !tail && method === 'PATCH') {
      const m = find(id); if (!m) return json(404, { error: 'not_found' });
      if (body.role) {
        if (body.role === 'OWNER' && m.status !== 'ACTIVE') return conflict('member_not_active');
        if (m.role === 'OWNER' && body.role !== 'OWNER' && activeOwners(slug, m.id) === 0) return conflict('last_owner');
        m.role = body.role as MemberData['role'];
      } else m.status = body.status as MemberData['status'];
      return json(200, { member: m });
    }
    if (area === 'members' && id && !tail && method === 'DELETE') {
      const m = find(id); if (!m) return json(404, { error: 'not_found' });
      if (m.role === 'OWNER' && activeOwners(slug, m.id) === 0) return conflict('last_owner');
      members[slug] = list.filter((x) => x.id !== id);
      return json(200, { ok: true });
    }
    if (area === 'members' && tail === 'transfer-ownership') {
      const m = find(id); if (!m) return json(404, { error: 'not_found' });
      if (m.status !== 'ACTIVE') return conflict('member_not_active');
      if (m.role === 'OWNER') return conflict('already_owner');
      m.role = 'OWNER';
      if (body.stepDown) { const me = list.find((x) => x.id === me_id); if (me) me.role = 'ADMIN'; }
      return json(200, { member: m });
    }
    if (area === 'membership' && id === 'step-down') {
      const me = find(me_id)!; if (activeOwners(slug, me.id) === 0) return conflict('last_owner');
      me.role = 'ADMIN'; return json(200, { member: me });
    }
    if (area === 'membership' && id === 'leave') {
      const me = find(me_id)!; if (me.role === 'OWNER' && activeOwners(slug, me.id) === 0) return conflict('last_owner');
      members[slug] = list.filter((x) => x.id !== me_id); return json(200, { ok: true });
    }
    if (area === 'invitations' && !id && method === 'GET') return json(200, { invitations: invitations[slug] });
    if (area === 'invitations' && !id && method === 'POST') {
      const email = String(body.email).toLowerCase();
      if (list.some((m) => m.email?.toLowerCase() === email)) return conflict('already_member');
      if (invitations[slug]!.some((i) => i.email === email)) return conflict('invitation_exists');
      const invitation: InvitationData = { id: crypto.randomUUID(), email, role: body.role as InvitationData['role'], expiresAt: '2026-11-24T00:00:00.000Z', createdAt: '2026-11-17T00:00:00.000Z' };
      invitations[slug]!.push(invitation);
      return json(201, { invitation, delivery: options.deliveryFails ? 'failed' : 'sent' });
    }
    if (area === 'invitations' && id && tail === 'resend') {
      const inv = invitations[slug]!.find((i) => i.id === id); if (!inv) return conflict('invitation_closed');
      if (options.resendTooSoon) return json(429, { error: 'rate_limited' });
      const fresh = { ...inv, id: crypto.randomUUID() };
      invitations[slug] = invitations[slug]!.map((i) => (i.id === id ? fresh : i));
      return json(201, { invitation: fresh, delivery: options.deliveryFails ? 'failed' : 'sent' });
    }
    if (area === 'invitations' && id && method === 'DELETE') {
      if (!invitations[slug]!.some((i) => i.id === id)) return conflict('invitation_closed');
      invitations[slug] = invitations[slug]!.filter((i) => i.id !== id); return json(200, { ok: true });
    }
    return json(404, { error: 'not_found' });
  };
  let me_id = '';

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET' && gate) await gate;
    const failure = failures.shift();
    if (failure === 'network') throw new TypeError('network down');
    if (typeof failure === 'number') return json(failure, { error: failure === 403 ? 'forbidden' : 'server_error' });
    const roles = /^\/api\/v1\/b\/([^/]+)\/access\/roles$/.exec(url.pathname);
    if (roles) return members[roles[1]!] && method === 'GET' ? json(200, access.model) : json(members[roles[1]!] ? 405 : 404, { error: 'not_found' });
    const team = /^\/api\/v1\/b\/([^/]+)\/(members|invitations|membership)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
    if (team) return teamRoute(team[1]!, team[2]!, team[3], team[4], method, body);
    const match = /^\/api\/v1\/b\/([^/]+)\/business$/.exec(url.pathname);
    if (!match) return json(404, { error: 'not_found' });
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
    fetch: fakeFetch, profiles, calls, members, invitations, options, access,
    setMe: (id: string) => { me_id = id; },
    failNext: (answers) => { failures = [...answers]; },
    editElsewhere: (slug, change) => { const p = profiles[slug]!; profiles[slug] = { ...p, ...change, version: p.version + 1 }; },
    hold: () => {
      gate = new Promise<void>((resolve) => { release = resolve; });
      return () => { release?.(); gate = null; };
    },
  };
}
