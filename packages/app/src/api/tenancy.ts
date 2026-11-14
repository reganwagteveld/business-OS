import { BusinessContextResponse, CreateBusinessRequest, CreateBusinessResponse, endpointPath, endpoints, ListBusinessesResponse, type Role } from '@business-os/contracts';
import { createRequester } from './http';
import type { AuthTransport } from './auth';

/**
 * Every outcome a screen has to handle, kept apart on purpose: being offline is NOT being signed out,
 * and a server error is neither.
 */
export type Outcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unauthenticated' }
  | { kind: 'unverified' }
  | { kind: 'forbidden' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'rate_limited' }
  | { kind: 'invalid_input'; message: string; fields?: Record<string, string> }
  | { kind: 'unreachable' }
  | { kind: 'failed'; status: number }
  | { kind: 'invalid' }
  /** The list is longer than this screen loads in one go. Shown as an error, never as a partial list. */
  | { kind: 'incomplete'; message: string };

export interface BusinessSummary {
  slug: string;
  name: string;
  role: Role;
}

export interface BusinessContext {
  business: { slug: string; name: string; countryCode: string; timeZone: string; locale: string; currency: string };
  membership: { id: string; role: Role; permissions: string[] };
}

export interface TenancyClient {
  listBusinesses(signal?: AbortSignal): Promise<Outcome<BusinessSummary[]>>;
  businessContext(slug: string, signal?: AbortSignal): Promise<Outcome<BusinessContext>>;
  /**
   * Creates a business for the signed-in user. The input is checked against the shared contract
   * first, so a stray field (such as a business id) is rejected before anything is sent.
   * `unreachable` here is ambiguous: the server may have committed, so callers re-read memberships.
   */
  createBusiness(input: unknown, signal?: AbortSignal): Promise<Outcome<{ slug: string }>>;
}

export function classify(status: number, json: unknown): Outcome<never> | null {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 403) return (json as { error?: string } | undefined)?.error === 'email_not_verified' ? { kind: 'unverified' } : { kind: 'forbidden' };
  if (status === 404) return { kind: 'not_found' };
  if (status === 409) return { kind: 'conflict' };
  if (status === 429) return { kind: 'rate_limited' };
  if (status >= 400) return { kind: 'failed', status };
  return null;
}

/** Typed tenant calls over the shared transport. Responses are validated against the shared contracts. */
export function createTenancyClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): TenancyClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  return {
    async listBusinesses(signal) {
      const raw = await http.request('GET', endpoints.listBusinesses.path, undefined, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = ListBusinessesResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: parsed.data.businesses } : { kind: 'invalid' };
    },
    async businessContext(slug, signal) {
      const raw = await http.request('GET', endpointPath(endpoints.businessContext.path, { slug }), undefined, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = BusinessContextResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'invalid' };
    },
    async createBusiness(input, signal) {
      const checked = CreateBusinessRequest.safeParse(input);
      if (!checked.success) return { kind: 'invalid_input', message: checked.error.issues[0]?.message ?? 'Check your business details.' };
      const raw = await http.request('POST', endpoints.createBusiness.path, checked.data, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      if (raw.status === 400) return { kind: 'invalid_input', message: 'Please check your business details and try again.' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = CreateBusinessResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: { slug: parsed.data.business.slug } } : { kind: 'invalid' };
    },
  };
}
