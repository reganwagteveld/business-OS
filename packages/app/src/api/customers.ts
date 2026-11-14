import {
  ActivityResponse, ContactResponse, CreateActivityRequest, CreateContactRequest, CreateCustomerRequest, CustomerResponse, CustomerSummaryResponse, endpointPath, endpoints,
  ListActivitiesResponse, ListContactsResponse, ListCustomersResponse, UpdateContactRequest,
  MembersResponse, UpdateCustomerRequest, type Activity, type Contact, type Customer, type CustomerSummary, Member as MemberSchema,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

/** Contacts per customer the panel loads (100 per page). Beyond this it reports an error rather than a partial list. */
export const MAX_CONTACT_PAGES = 50;

export type RecordStatus = 'active' | 'archived' | 'all';
export interface CustomerPage { customers: Customer[]; nextCursor: string | null }
export interface ActivityPage { activities: Activity[]; nextCursor: string | null }
export type Member = z.infer<typeof MemberSchema>;
export type CustomerInput = z.input<typeof CreateCustomerRequest>;
export type CustomerPatch = z.input<typeof UpdateCustomerRequest>;

/** Customer Zone calls. The business is only ever the `:slug` in the path; no call carries a business id. */
export interface CustomersClient {
  list(slug: string, query: { q?: string; status: RecordStatus; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<Outcome<CustomerPage>>;
  /** Active and archived customer counts and active contacts, for the Zone home. */
  summary(slug: string, signal?: AbortSignal): Promise<Outcome<CustomerSummary>>;
  get(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  create(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Customer>>;
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Customer>>;
  archive(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  restore(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  /** Every contact of one customer in the given state, following the server's cursors (so the primary is never cut off). */
  contacts(slug: string, customerId: string, status?: 'active' | 'archived', signal?: AbortSignal): Promise<Outcome<Contact[]>>;
  getContact(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Contact>>;
  createContact(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Contact>>;
  updateContact(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Contact>>;
  archiveContact(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Contact>>;
  restoreContact(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Contact>>;
  /** Logs a note, call, meeting or email. The server attributes it to the signed-in person. */
  createActivity(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Activity>>;
  activities(slug: string, customerId: string, cursor?: string, signal?: AbortSignal): Promise<Outcome<ActivityPage>>;
  /** Active members, for the optional customer owner. */
  members(slug: string, signal?: AbortSignal): Promise<Outcome<Member[]>>;
}

/** Maps the contract's field paths to the first message per field, so forms can show them inline. */
function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

function invalid(error: z.ZodError): Outcome<never> {
  const fields = fieldErrors(error);
  return { kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields };
}

export function createCustomersClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): CustomersClient {
  const http = createRequester(baseUrl, transport, fetchImpl);

  /** Shared tail of every call: network, status classes, then the response checked against the contract. */
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? (body?.error === 'invalid_cursor' ? 'That page is no longer valid. Start again from the first page.' : 'Please check the details and try again.') };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }

  const path = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '') params.set(key, String(value));
    const text = params.toString();
    return text ? `?${text}` : '';
  };

  return {
    async list(slug, query, signal) {
      const raw = await http.request('GET', path(endpoints.listCustomers.path, { slug }) + qs({ q: query.q?.trim(), status: query.status, cursor: query.cursor, limit: query.limit }), undefined, signal);
      return settle(raw, ListCustomersResponse, (d) => d);
    },
    async summary(slug, signal) {
      return settle(await http.request('GET', path(endpoints.customerSummary.path, { slug }), undefined, signal), CustomerSummaryResponse, (d) => d.summary);
    },
    async get(slug, id, signal) {
      return settle(await http.request('GET', path(endpoints.getCustomer.path, { slug, customerId: id }), undefined, signal), CustomerResponse, (d) => d.customer);
    },
    async create(slug, input, signal) {
      const checked = CreateCustomerRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error); // also rejects a stray business id before anything is sent
      return settle(await http.request('POST', path(endpoints.createCustomer.path, { slug }), checked.data, signal), CustomerResponse, (d) => d.customer);
    },
    async update(slug, id, patch, signal) {
      const checked = UpdateCustomerRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', path(endpoints.updateCustomer.path, { slug, customerId: id }), checked.data, signal), CustomerResponse, (d) => d.customer);
    },
    async archive(slug, id, signal) {
      return settle(await http.request('POST', path(endpoints.archiveCustomer.path, { slug, customerId: id }), undefined, signal), CustomerResponse, (d) => d.customer);
    },
    async restore(slug, id, signal) {
      return settle(await http.request('POST', path(endpoints.restoreCustomer.path, { slug, customerId: id }), undefined, signal), CustomerResponse, (d) => d.customer);
    },
    async contacts(slug, customerId, status = 'active', signal) {
      const all: Contact[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_CONTACT_PAGES; page++) {
        const raw = await http.request('GET', path(endpoints.listContacts.path, { slug }) + qs({ customerId, status, limit: 100, cursor }), undefined, signal);
        const outcome = settle(raw, ListContactsResponse, (d) => d);
        if (outcome.kind !== 'ok') return outcome;
        all.push(...outcome.data.contacts);
        if (!outcome.data.nextCursor) return { kind: 'ok', data: all };
        cursor = outcome.data.nextCursor;
      }
      // Still more after the last page we allow: say so, never return a silently truncated list
      // (the primary contact, or the one someone is looking for, could be in the missing part).
      return { kind: 'incomplete', message: `This customer has more than ${MAX_CONTACT_PAGES * 100} contacts, more than this panel can show.` };
    },
    async getContact(slug, id, signal) {
      return settle(await http.request('GET', path(endpoints.getContact.path, { slug, contactId: id }), undefined, signal), ContactResponse, (d) => d.contact);
    },
    async createContact(slug, input, signal) {
      const checked = CreateContactRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', path(endpoints.createContact.path, { slug }), checked.data, signal), ContactResponse, (d) => d.contact);
    },
    async updateContact(slug, id, input, signal) {
      const checked = UpdateContactRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', path(endpoints.updateContact.path, { slug, contactId: id }), checked.data, signal), ContactResponse, (d) => d.contact);
    },
    async archiveContact(slug, id, signal) {
      return settle(await http.request('POST', path(endpoints.archiveContact.path, { slug, contactId: id }), undefined, signal), ContactResponse, (d) => d.contact);
    },
    async restoreContact(slug, id, signal) {
      return settle(await http.request('POST', path(endpoints.restoreContact.path, { slug, contactId: id }), undefined, signal), ContactResponse, (d) => d.contact);
    },
    async createActivity(slug, input, signal) {
      const checked = CreateActivityRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', path(endpoints.createActivity.path, { slug }), checked.data, signal), ActivityResponse, (d) => d.activity);
    },
    async activities(slug, customerId, cursor, signal) {
      const raw = await http.request('GET', path(endpoints.listActivities.path, { slug }) + qs({ customerId, cursor, limit: 25 }), undefined, signal);
      return settle(raw, ListActivitiesResponse, (d) => d);
    },
    async members(slug, signal) {
      const raw = await http.request('GET', path(endpoints.listMembers.path, { slug }), undefined, signal);
      return settle(raw, MembersResponse, (d) => d.members.filter((m) => m.status === 'ACTIVE'));
    },
  };
}
