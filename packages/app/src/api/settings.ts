import { BusinessProfile, BusinessProfileResponse, endpointPath, endpoints, UpdateBusinessProfileRequest } from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester } from './http';
import { classify, type Outcome } from './tenancy';

export type BusinessProfileData = z.infer<typeof BusinessProfile>;

/**
 * Settings reads and writes (Administration A2 / A3 stage 1). Every call names the business only through
 * the URL, validates what it sends against the shared contract (so a stray field is refused before any
 * request) and validates what comes back. The server stays authoritative: the client never decides who
 * may do something, it only shows what the server's permission keys allow.
 */
export interface SettingsClient {
  businessProfile(slug: string, signal?: AbortSignal): Promise<Outcome<BusinessProfileData>>;
  /**
   * Partial edit. `patch` must carry the `version` the edit was based on; a different current version
   * answers `conflict` with code `stale`, and nothing is written.
   */
  updateBusinessProfile(slug: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<BusinessProfileData>>;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

export function createSettingsClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): SettingsClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  return {
    async businessProfile(slug, signal) {
      const raw = await http.request('GET', endpointPath(endpoints.getBusinessProfile.path, { slug }), undefined, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = BusinessProfileResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: parsed.data.business } : { kind: 'invalid' };
    },
    async updateBusinessProfile(slug, patch, signal) {
      const checked = UpdateBusinessProfileRequest.safeParse(patch);
      if (!checked.success) {
        return { kind: 'invalid_input', message: checked.error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(checked.error) };
      }
      const raw = await http.request('PATCH', endpointPath(endpoints.updateBusinessProfile.path, { slug }), checked.data, signal);
      if (raw.kind === 'network') return { kind: 'unreachable' };
      if (raw.status === 400) {
        const body = raw.json as { message?: string } | undefined;
        return { kind: 'invalid_input', message: body?.message ?? 'Please check the details and try again.' };
      }
      const bad = classify(raw.status, raw.json);
      if (bad) return bad;
      const parsed = BusinessProfileResponse.safeParse(raw.json);
      return parsed.success ? { kind: 'ok', data: parsed.data.business } : { kind: 'invalid' };
    },
  };
}
