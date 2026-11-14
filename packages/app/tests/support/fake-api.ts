/**
 * A stand-in for the PR 11 API, for tests only: an in-memory fetch that follows the same contract
 * (paths, query, status codes, strict bodies) and keeps each business's records apart. The app's real
 * client and contract schemas sit in front of it, so a response that breaks the contract fails the test.
 */
import { CreateActivityRequest, CreateContactRequest, UpdateContactRequest, CreateCustomerRequest, UpdateCustomerRequest, type Activity, type Contact, type Customer } from '@business-os/contracts';
import { randomUUID } from 'node:crypto';

export interface FakeMember { id: string; userId: string; name: string | null; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER'; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string }
export interface FakeBusiness { customers: Customer[]; contacts: Contact[]; activities: Activity[]; members: FakeMember[] }
export interface Call { method: string; slug: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }
type Interceptor = (call: Call) => Response | Promise<Response> | 'network' | undefined;

const NOW = '2026-11-14T03:00:00.000Z';
export const uuid = () => randomUUID();

export function customer(over: Partial<Customer> = {}): Customer {
  return {
    id: uuid(), kind: 'COMPANY', displayName: 'Customer', legalName: null, email: null, phone: null, website: null, taxNumber: null, taxNumberType: null,
    addressLine1: null, addressLine2: null, city: null, region: null, postalCode: null, countryCode: null, notes: null, ownerUserId: null,
    primaryContactId: null, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  };
}
export function contact(customerId: string | null, over: Partial<Contact> = {}): Contact {
  return {
    id: uuid(), customerId, firstName: null, lastName: null, displayName: 'Contact', email: null, phone: null, mobile: null, jobTitle: null, notes: null,
    createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  };
}
export function activity(customerId: string | null, over: Partial<Activity> = {}): Activity {
  return {
    id: uuid(), type: 'note', occurredAt: NOW, actorType: 'USER', actorUserId: null, customerId, contactId: null, subject: null, body: null, data: {}, createdAt: NOW, ...over,
  };
}
export const emptyBusiness = (): FakeBusiness => ({ customers: [], contacts: [], activities: [], members: [] });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cursorOf = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
const offsetOf = (cursor: string | undefined) => (cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o: number }).o : 0);

export function createFakeApi(businesses: Record<string, FakeBusiness>) {
  const calls: Call[] = [];
  const once: Interceptor[] = [];
  const gates: Promise<void>[] = [];
  const api = {
    businesses,
    calls,
    /** Answer the next request yourself (a 500, a hung request, a network failure). */
    next(handler: Interceptor) {
      once.push(handler);
    },
    /** Delays the next request until the returned function is called, then lets it through normally. */
    hold(): () => void {
      let release!: () => void;
      gates.push(new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    callsTo(pattern: RegExp) {
      return calls.filter((c) => pattern.test(`${c.method} ${c.path}`));
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const match = /^\/api\/v1\/b\/([^/]+)\/(customers|contacts|activities|members)(?:\/([^/]+))?(?:\/(archive|restore))?$/.exec(url.pathname);
      const method = init?.method ?? 'GET';
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const call: Call = {
        method, slug: match?.[1] ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers,
      };
      calls.push(call);
      const gate = gates.shift();
      if (gate) await gate;
      const handler = once.shift();
      if (handler) {
        const answered = handler(call);
        if (answered === 'network') throw new TypeError('Failed to fetch');
        if (answered) return answered;
      }
      if (!match) return json(404, { error: 'not_found' });
      const biz = businesses[match[1]!];
      if (!biz) return json(404, { error: 'not_found' }); // not a member of this business
      const [, , resource, id, action] = match;
      const now = new Date().toISOString();

      if (resource === 'members') return json(200, { members: biz.members });

      if (resource === 'contacts' && method === 'GET') {
        const q = call.query;
        const rows = biz.contacts.filter((c) => (!q.customerId || c.customerId === q.customerId) && (q.status === 'all' ? true : q.status === 'archived' ? c.archivedAt : !c.archivedAt));
        return json(200, { contacts: rows, nextCursor: null });
      }

      if (resource === 'activities' && method === 'GET') {
        const q = call.query;
        const rows = biz.activities.filter((a) => !q.customerId || a.customerId === q.customerId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
        const start = offsetOf(q.cursor);
        const limit = Number(q.limit ?? 25);
        return json(200, { activities: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? cursorOf(start + limit) : null });
      }

      if (resource === 'contacts') {
        if (!id && method === 'POST') {
          const parsed = CreateContactRequest.safeParse(call.body);
          if (!parsed.success) return json(400, { error: 'invalid_input' });
          const row = contact(parsed.data.customerId ?? null, { ...parsed.data, id: uuid(), displayName: parsed.data.displayName || [parsed.data.firstName, parsed.data.lastName].filter(Boolean).join(' ') || parsed.data.email || '', createdAt: now, updatedAt: now } as Contact);
          biz.contacts.push(row);
          return json(201, { contact: row });
        }
        const found = biz.contacts.find((c) => c.id === id);
        if (!found) return json(404, { error: 'not_found' });
        if (method === 'PATCH') {
          const parsed = UpdateContactRequest.safeParse(call.body);
          if (!parsed.success) return json(400, { error: 'invalid_input' });
          if (found.archivedAt) return json(409, { error: 'archived' });
          Object.assign(found, parsed.data, { updatedAt: now });
          return json(200, { contact: found });
        }
        if (method === 'POST' && (action === 'archive' || action === 'restore')) {
          found.archivedAt = action === 'archive' ? now : null;
          if (action === 'archive') for (const c of biz.customers) if (c.primaryContactId === found.id) c.primaryContactId = null;
          return json(200, { contact: found });
        }
      }
      if (resource === 'activities' && method === 'POST') {
        const parsed = CreateActivityRequest.safeParse(call.body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        const row = activity(parsed.data.customerId ?? null, { ...parsed.data, id: uuid(), occurredAt: parsed.data.occurredAt ?? now, createdAt: now } as Activity);
        biz.activities.push(row);
        return json(201, { activity: row });
      }
      if (resource !== 'customers') return json(404, { error: 'not_found' });

      if (!id && method === 'GET') {
        const q = call.query;
        const term = q.q?.toLowerCase();
        const rows = biz.customers
          .filter((c) => (q.status === 'all' ? true : q.status === 'archived' ? c.archivedAt : !c.archivedAt))
          .filter((c) => !term || [c.displayName, c.legalName, c.email, c.phone].some((v) => v?.toLowerCase().includes(term)))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        const start = offsetOf(q.cursor);
        const limit = Number(q.limit ?? 25);
        return json(200, { customers: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? cursorOf(start + limit) : null });
      }
      if (!id && method === 'POST') {
        const parsed = CreateCustomerRequest.safeParse(call.body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        const created = customer({ ...parsed.data, id: uuid(), createdAt: now, updatedAt: now } as Partial<Customer>);
        biz.customers.push(created);
        return json(201, { customer: created });
      }
      const found = biz.customers.find((c) => c.id === id);
      if (!found) return json(404, { error: 'not_found' });
      if (method === 'GET') return json(200, { customer: found });
      if (method === 'PATCH') {
        const parsed = UpdateCustomerRequest.safeParse(call.body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        if (found.archivedAt) return json(409, { error: 'archived' });
        Object.assign(found, parsed.data, { updatedAt: now });
        return json(200, { customer: found });
      }
      if (method === 'POST' && action === 'archive') {
        if (found.archivedAt) return json(409, { error: 'archived' });
        Object.assign(found, { archivedAt: now, updatedAt: now });
        return json(200, { customer: found });
      }
      if (method === 'POST' && action === 'restore') {
        if (!found.archivedAt) return json(409, { error: 'not_archived' });
        Object.assign(found, { archivedAt: null, updatedAt: now });
        return json(200, { customer: found });
      }
      return json(404, { error: 'not_found' });
    }) as typeof fetch,
  };
  return api;
}
