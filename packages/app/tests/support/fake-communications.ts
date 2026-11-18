/**
 * A stand-in for the Communications connection API (docs/communications-c2.md §10, §16), for tests only. It wraps the
 * shared test API and follows the server's record rules for mailboxes: a connection you may not see is a 404, only an owner
 * changes a PERSONAL mailbox, manage_connections changes any, sharing needs the retention period, and business setup needs
 * manage_connections. Provider consent is simulated by returning an allowlisted address; nothing connects by itself.
 * The app's real client and contracts sit in front of it. There is no mail here because the real API has none.
 */
import {
  AuthorizeMailConnectionRequest, CreateMailBusinessAddressRequest, CreateMailBusinessDomainRequest, SetMailConnectionMemberRequest, SetMailRetentionRequest, UpdateMailConnectionRequest,
  type MailBusinessAddress, type MailBusinessDomain, type MailConnection, type MailConnectionMember, type MailRetention,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import type { createFakeApi } from './fake-api';

export interface FakeComms {
  connections: MailConnection[]; members: Record<string, MailConnectionMember[]>; domains: MailBusinessDomain[]; addresses: MailBusinessAddress[]; retention: MailRetention;
  providers: { provider: 'GOOGLE' | 'MICROSOFT'; configured: boolean; revokesOnDisconnect: boolean }[];
  permissions: string[]; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
}
export const emptyComms = (permissions = ['communications:read', 'communications:connect']): FakeComms => ({
  connections: [], members: {}, domains: [], addresses: [], retention: { ordinaryRetentionDays: null, updatedAt: null, version: null },
  providers: [{ provider: 'GOOGLE', configured: true, revokesOnDisconnect: false }, { provider: 'MICROSOFT', configured: false, revokesOnDisconnect: false }],
  permissions, role: 'MANAGER',
});

const NOW = '2026-11-17T03:00:00.000Z';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function connection(over: Partial<MailConnection> = {}): MailConnection {
  return {
    id: randomUUID(), provider: 'GOOGLE', mailboxAddress: 'ada@example.com', displayName: 'Ada', kind: 'PERSONAL', ownerUserId: randomUUID(), isOwner: true, credentialHolderId: randomUUID(),
    businessAddressId: null, status: 'ACTIVE', sharing: 'OWNER_ONLY', syncEnabled: true, lastSyncedAt: null, lastErrorCode: null, connectedAt: NOW, disconnectedAt: null, version: 1, createdAt: NOW, ...over,
  };
}

export function withComms(api: ReturnType<typeof createFakeApi>, data: Record<string, FakeComms>) {
  const base = api.fetch;
  const next: ((path: string, method: string) => Response | 'network' | undefined)[] = [];
  const out = Object.assign(api, {
    comms: data,
    commsNext(handler: (path: string, method: string) => Response | 'network' | undefined) { next.push(handler); },
  });
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)\/communications\/(.+)$/.exec(url.pathname);
    if (!m) return base(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, slug: m[1]!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: (init?.headers ?? {}) as Record<string, string> });
    for (let i = 0; i < next.length; i++) {
      const rule = next[i]!(url.pathname, method);
      if (rule !== undefined) { next.splice(i, 1); if (rule === 'network') throw new TypeError('Failed to fetch'); return rule; }
    }
    const s = data[m[1]!];
    if (!s) return json(404, { error: 'not_found' });
    const has = (k: string) => s.permissions.includes(k);
    const rest = m[2]!.split('/');
    const manage = has('communications:manage_connections');
    if (!has('communications:read')) return json(403, { error: 'forbidden' });

    if (rest[0] === 'providers') return has('communications:connect') ? json(200, { providers: s.providers }) : json(403, { error: 'forbidden' });
    if (rest[0] === 'retention') {
      if (method === 'GET') return json(200, { retention: s.retention });
      if (!manage) return json(403, { error: 'forbidden' });
      const parsed = SetMailRetentionRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (parsed.data.version !== s.retention.version) return json(409, { error: 'stale' });
      s.retention = { ordinaryRetentionDays: parsed.data.ordinaryRetentionDays, updatedAt: NOW, version: (s.retention.version ?? 0) + 1 };
      return json(200, { retention: s.retention });
    }
    if (rest[0] === 'business-domains' || rest[0] === 'business-addresses') {
      if (!manage) return json(403, { error: 'forbidden' });
      if (rest[0] === 'business-domains') {
        if (!rest[1]) {
          if (method === 'GET') return json(200, { domains: s.domains });
          const parsed = CreateMailBusinessDomainRequest.safeParse(body);
          if (!parsed.success) return json(400, { error: 'invalid_input' });
          const d: MailBusinessDomain = { id: randomUUID(), domain: parsed.data.domain, status: 'PENDING', dnsRecord: { type: 'TXT', name: `_business-os-verification.${parsed.data.domain}`, value: 'business-os-verification=abc' }, verifiedAt: null, createdAt: NOW, version: 1 };
          s.domains.push({ ...d, dnsRecord: { type: 'TXT', name: d.dnsRecord.name } });
          return json(201, { domain: d });
        }
        const d = s.domains.find((x) => x.id === rest[1]);
        if (!d) return json(404, { error: 'not_found' });
        if (rest[2] === 'verify') { d.status = 'VERIFIED'; d.verifiedAt = NOW; d.version += 1; }
        else { d.status = 'REMOVED'; d.version += 1; }
        return json(200, { domain: d });
      }
      if (!rest[1]) {
        if (method === 'GET') return json(200, { addresses: s.addresses });
        const parsed = CreateMailBusinessAddressRequest.safeParse(body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        const consumer = /@(gmail|outlook|hotmail)\.com$/.test(parsed.data.address);
        if (consumer && !parsed.data.attestation) return json(409, { error: 'consumer_domain' });
        if (consumer && s.role !== 'OWNER') return json(403, { error: 'forbidden' });
        const a: MailBusinessAddress = { id: randomUUID(), address: parsed.data.address, basis: consumer ? 'OWNER_ATTESTATION' : 'VERIFIED_DOMAIN', domainId: null, attestedById: null, attestedAt: null, connectionId: null, removedAt: null, createdAt: NOW, version: 1 };
        s.addresses.push(a);
        return json(201, { address: a });
      }
      const a = s.addresses.find((x) => x.id === rest[1]);
      if (!a) return json(404, { error: 'not_found' });
      a.removedAt = NOW; a.version += 1;
      return json(200, { address: a });
    }
    if (rest[0] !== 'connections') return json(404, { error: 'not_found' });

    if (rest[1] === 'authorize') {
      if (!has('communications:connect')) return json(403, { error: 'forbidden' });
      const parsed = AuthorizeMailConnectionRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      const p = s.providers.find((x) => x.provider === parsed.data.provider);
      if (!p?.configured) return json(409, { error: 'provider_not_configured' });
      const host = parsed.data.provider === 'GOOGLE' ? 'accounts.google.com' : 'login.microsoftonline.com';
      return json(200, { authorizationUrl: `https://${host}/consent?state=one-time`, expiresAt: NOW });
    }
    // Visible: your own, a business-shared personal one, a business mailbox you manage or are a member of; managers see all metadata.
    const visible = (c: MailConnection) => manage || c.isOwner || c.sharing !== 'OWNER_ONLY';
    if (!rest[1]) {
      const includeAll = url.searchParams.get('includeDisconnected') === 'true';
      return json(200, { connections: s.connections.filter((c) => visible(c) && (includeAll || c.status !== 'DISCONNECTED')) });
    }
    const c = s.connections.find((x) => x.id === rest[1]);
    if (!c || !visible(c)) return json(404, { error: 'not_found' });
    const mayChange = c.isOwner ? has('communications:connect') : manage;
    if (rest[2] === 'members') {
      const list = (s.members[c.id] ??= []);
      if (!rest[3]) return json(200, { members: list });
      if (!manage) return json(403, { error: 'forbidden' });
      if (rest[4] === 'remove') s.members[c.id] = list.filter((x) => x.userId !== rest[3]);
      else {
        const parsed = SetMailConnectionMemberRequest.safeParse(body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        const existing = list.find((x) => x.userId === rest[3]);
        if (existing) existing.access = parsed.data.access;
        else list.push({ userId: rest[3]!, access: parsed.data.access, grantedById: randomUUID(), grantedAt: NOW, version: 1 });
      }
      return json(200, { members: s.members[c.id] });
    }
    if (!mayChange) return json(403, { error: 'forbidden' });
    if (rest[2] === 'disconnect') { c.status = 'DISCONNECTED'; c.disconnectedAt = NOW; c.version += 1; return json(200, { connection: c }); }
    if (method === 'PATCH') {
      const parsed = UpdateMailConnectionRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (parsed.data.version !== c.version) return json(409, { error: 'stale' });
      if (parsed.data.sharing === 'BUSINESS' && s.retention.ordinaryRetentionDays === null) return json(409, { error: 'retention_not_set' });
      if (parsed.data.sharing) c.sharing = parsed.data.sharing;
      if (parsed.data.syncEnabled !== undefined) c.syncEnabled = parsed.data.syncEnabled;
      c.version += 1;
      return json(200, { connection: c });
    }
    return json(200, { connection: c });
  }) as typeof fetch;
  return out;
}
