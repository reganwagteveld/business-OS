import {
  CreateCustomerRequest, CustomerResponse, endpointPath, endpoints, ListActivitiesResponse, ListContactsResponse, ListCustomersResponse,
  MembersResponse, UpdateCustomerRequest, type Activity, type Contact, type Customer, Member as MemberSchema,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type RecordStatus = 'active' | 'archived' | 'all';
export interface CustomerPage { customers: Customer[]; nextCursor: string | null }
export interface ActivityPage { activities: Activity[]; nextCursor: string | null }
export type Member = z.infer<typeof MemberSchema>;
export type CustomerInput = z.input<typeof CreateCustomerRequest>;
export type CustomerPatch = z.input<typeof UpdateCustomerRequest>;

/** Customer Zone calls. The business is only ever the `:slug` in the path; no call carries a business id. */
export interface CustomersClient {
  list(slug: string, query: { q?: string; status: RecordStatus; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<Outcome<CustomerPage>>;
  get(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  create(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Customer>>;
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Customer>>;
  archive(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  restore(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Customer>>;
  contacts(slug: string, customerId: string, signal?: AbortSignal): Promise<Outcome<Contact[]>>;
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
    async contacts(slug, customerId, signal) {
      const raw = await http.request('GET', path(endpoints.listContacts.path, { slug }) + qs({ customerId, status: 'active', limit: 100 }), undefined, signal);
      return settle(raw, ListContactsResponse, (d) => d.contacts);
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
