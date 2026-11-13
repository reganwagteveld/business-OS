import {
  BusinessContextResponse, CreateBusinessRequest, CreateBusinessResponse,
  endpoints, endpointPath, ListBusinessesResponse,
} from '@business-os/contracts';
import { z } from 'zod';
import type { AuthClient, AuthResult } from './auth';

type BusinessSummary = z.infer<typeof import('@business-os/contracts').BusinessSummary>;
type BusinessContext = z.infer<typeof BusinessContextResponse>;

export type WorkspaceResult<T> = AuthResult<T>;

/** Tenant operations share the existing browser-cookie or desktop-keychain bearer transport. */
export function createWorkspaceClient(baseUrl: string, auth: AuthClient, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request<T>(method: string, path: string, schema: { safeParse(value: unknown): { success: boolean; data?: T } }, body?: unknown): Promise<WorkspaceResult<T>> {
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (auth.transport.kind === 'bearer') {
        const token = await auth.transport.getToken();
        if (!token) return { ok: false, status: 401, message: 'Your session has expired. Please sign in again.' };
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: auth.transport.kind === 'cookie' ? 'include' : 'omit', cache: 'no-store',
      });
      if (!response.ok) {
        return { ok: false, status: response.status, message: response.status === 401
          ? 'Your session has expired. Please sign in again.'
          : response.status === 409 ? 'That workspace address is already taken. Choose another.'
          : response.status === 403 ? 'You do not have access to this workspace.'
          : response.status === 429 ? 'Too many requests. Please try again shortly.'
          : 'The server could not complete your request. Please try again.' };
      }
      const parsed = schema.safeParse(await response.json());
      return parsed.success && parsed.data !== undefined
        ? { ok: true, data: parsed.data }
        : { ok: false, status: 502, message: 'The server returned an unexpected response.' };
    } catch {
      return { ok: false, status: 0, message: 'Cannot reach Business OS. Check your connection and retry.' };
    }
  }
  return {
    async list() {
      const result = await request<{ businesses: BusinessSummary[] }>('GET', endpoints.listBusinesses.path, ListBusinessesResponse);
      return result;
    },
    async context(slug: string) {
      return request<BusinessContext>('GET', endpointPath(endpoints.businessContext.path, { slug }), BusinessContextResponse);
    },
    async create(input: unknown) {
      const parsed = CreateBusinessRequest.safeParse(input);
      if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? 'Check your business details.' } as const;
      return request<{ business: { slug: string } }>('POST', endpoints.createBusiness.path, CreateBusinessResponse, parsed.data);
    },
  };
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
