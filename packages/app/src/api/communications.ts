import {
  AuthorizeMailConnectionRequest, AuthorizeMailConnectionResponse, CreateMailBusinessAddressRequest, CreateMailBusinessDomainRequest, endpointPath, endpoints,
  ListMailBusinessAddressesResponse, ListMailBusinessDomainsResponse, ListMailConnectionMembersResponse, ListMailConnectionsResponse, ListMailProvidersResponse,
  MailBusinessAddressResponse, MailBusinessDomainResponse, MailConnectionResponse, MailRetentionResponse,
  SetMailConnectionMemberRequest, SetMailRetentionRequest, UpdateMailConnectionRequest, VersionedRequest,
  type MailBusinessAddress, type MailBusinessDomain, type MailConnection, type MailConnectionMember, type MailRetention,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export interface MailProviderInfo { provider: 'GOOGLE' | 'MICROSOFT'; configured: boolean; revokesOnDisconnect: boolean }

/**
 * Communications Zone calls for connected mailboxes (docs/communications-c2.md §10 and §16, docs/communications-c2-ui.md).
 * The business is only the `:slug` in the path. Bodies are checked against the shared contract before they are sent.
 * No call here reads, lists, syncs or sends mail: that backend does not exist yet (sync-job endpoints are deliberately unused). Authorisation is the API's; the screens
 * only decide what to show.
 */
export interface CommunicationsClient {
  providers(slug: string, signal?: AbortSignal): Promise<Outcome<MailProviderInfo[]>>;
  connections(slug: string, includeDisconnected: boolean, signal?: AbortSignal): Promise<Outcome<MailConnection[]>>;
  /** Starts a provider consent. Open the returned address in this browser: it expires quickly and works once. */
  authorize(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<{ authorizationUrl: string; expiresAt: string }>>;
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<MailConnection>>;
  disconnect(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<MailConnection>>;
  members(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<MailConnectionMember[]>>;
  setMember(slug: string, id: string, userId: string, access: unknown, signal?: AbortSignal): Promise<Outcome<MailConnectionMember[]>>;
  removeMember(slug: string, id: string, userId: string, signal?: AbortSignal): Promise<Outcome<MailConnectionMember[]>>;
  domains(slug: string, signal?: AbortSignal): Promise<Outcome<MailBusinessDomain[]>>;
  addDomain(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<MailBusinessDomain>>;
  verifyDomain(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<MailBusinessDomain>>;
  removeDomain(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<MailBusinessDomain>>;
  addresses(slug: string, signal?: AbortSignal): Promise<Outcome<MailBusinessAddress[]>>;
  addAddress(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<MailBusinessAddress>>;
  removeAddress(slug: string, id: string, version: number, signal?: AbortSignal): Promise<Outcome<MailBusinessAddress>>;
  retention(slug: string, signal?: AbortSignal): Promise<Outcome<MailRetention>>;
  setRetention(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<MailRetention>>;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createCommunicationsClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): CommunicationsClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? 'Please check the details and try again.' };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const conn = (template: string, slug: string, id: string) => p(template, { slug, connectionId: id });

  return {
    async providers(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listMailProviders.path, { slug }), undefined, signal), ListMailProvidersResponse, (d) => d.providers);
    },
    async connections(slug, includeDisconnected, signal) {
      const path = p(endpoints.listMailConnections.path, { slug }) + (includeDisconnected ? '?includeDisconnected=true' : '');
      return settle(await http.request('GET', path, undefined, signal), ListMailConnectionsResponse, (d) => d.connections);
    },
    async authorize(slug, input, signal) {
      const checked = AuthorizeMailConnectionRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.authorizeMailConnection.path, { slug }), checked.data, signal), AuthorizeMailConnectionResponse, (d) => d);
    },
    async update(slug, id, patch, signal) {
      const checked = UpdateMailConnectionRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', conn(endpoints.updateMailConnection.path, slug, id), checked.data, signal), MailConnectionResponse, (d) => d.connection);
    },
    async disconnect(slug, id, signal) {
      return settle(await http.request('POST', conn(endpoints.disconnectMailConnection.path, slug, id), undefined, signal), MailConnectionResponse, (d) => d.connection);
    },
    async members(slug, id, signal) {
      return settle(await http.request('GET', conn(endpoints.listMailConnectionMembers.path, slug, id), undefined, signal), ListMailConnectionMembersResponse, (d) => d.members);
    },
    async setMember(slug, id, userId, access, signal) {
      const checked = SetMailConnectionMemberRequest.safeParse({ access });
      if (!checked.success) return invalid(checked.error);
      return settle(
        await http.request('PUT', p(endpoints.setMailConnectionMember.path, { slug, connectionId: id, userId }), checked.data, signal), ListMailConnectionMembersResponse, (d) => d.members,
      );
    },
    async removeMember(slug, id, userId, signal) {
      return settle(
        await http.request('POST', p(endpoints.removeMailConnectionMember.path, { slug, connectionId: id, userId }), undefined, signal), ListMailConnectionMembersResponse, (d) => d.members,
      );
    },
    async domains(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listMailBusinessDomains.path, { slug }), undefined, signal), ListMailBusinessDomainsResponse, (d) => d.domains);
    },
    async addDomain(slug, input, signal) {
      const checked = CreateMailBusinessDomainRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createMailBusinessDomain.path, { slug }), checked.data, signal), MailBusinessDomainResponse, (d) => d.domain);
    },
    async verifyDomain(slug, id, version, signal) {
      const body = VersionedRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.verifyMailBusinessDomain.path, { slug, domainId: id }), body, signal), MailBusinessDomainResponse, (d) => d.domain);
    },
    async removeDomain(slug, id, version, signal) {
      const body = VersionedRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.removeMailBusinessDomain.path, { slug, domainId: id }), body, signal), MailBusinessDomainResponse, (d) => d.domain);
    },
    async addresses(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listMailBusinessAddresses.path, { slug }), undefined, signal), ListMailBusinessAddressesResponse, (d) => d.addresses);
    },
    async addAddress(slug, input, signal) {
      const checked = CreateMailBusinessAddressRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createMailBusinessAddress.path, { slug }), checked.data, signal), MailBusinessAddressResponse, (d) => d.address);
    },
    async removeAddress(slug, id, version, signal) {
      const body = VersionedRequest.parse({ version });
      return settle(await http.request('POST', p(endpoints.removeMailBusinessAddress.path, { slug, addressId: id }), body, signal), MailBusinessAddressResponse, (d) => d.address);
    },
    async retention(slug, signal) {
      return settle(await http.request('GET', p(endpoints.getMailRetention.path, { slug }), undefined, signal), MailRetentionResponse, (d) => d.retention);
    },
    async setRetention(slug, input, signal) {
      const checked = SetMailRetentionRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PUT', p(endpoints.setMailRetention.path, { slug }), checked.data, signal), MailRetentionResponse, (d) => d.retention);
    },
  };
}
