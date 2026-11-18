import {
  AccessRolesResponse, BusinessProfile, BusinessProfileResponse, ConfirmRequest, CreateInvitationRequest, endpointPath, endpoints, Invitation, InvitationResponse, InvitationsResponse, Member, MemberResponse,
  MembersResponse, OkResponse, TransferOwnershipRequest, UpdateBusinessProfileRequest, UpdateMemberRequest, type Role,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type BusinessProfileData = z.infer<typeof BusinessProfile>;
export type MemberData = z.infer<typeof Member>;
export type InvitationData = z.infer<typeof Invitation>;
/** The fixed roles and what each may do (A2-C). Read-only: the same for every business and every caller. */
export type AccessModelData = z.infer<typeof AccessRolesResponse>;
/** `delivery` says whether the invitation email went out; the invitation exists either way. */
export type IssuedInvitation = { invitation: InvitationData; delivery: 'sent' | 'failed' };

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

  // ---- Team (A2-B). Every rule is enforced again by the server inside the transaction. ----------------
  /** Member emails come back only for callers holding members:invite. */
  members(slug: string, signal?: AbortSignal): Promise<Outcome<MemberData[]>>;
  changeRole(slug: string, membershipId: string, role: Role, signal?: AbortSignal): Promise<Outcome<MemberData>>;
  setMemberStatus(slug: string, membershipId: string, status: 'ACTIVE' | 'SUSPENDED', signal?: AbortSignal): Promise<Outcome<MemberData>>;
  removeMember(slug: string, membershipId: string, signal?: AbortSignal): Promise<Outcome<true>>;
  invitations(slug: string, signal?: AbortSignal): Promise<Outcome<InvitationData[]>>;
  invite(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<IssuedInvitation>>;
  resendInvitation(slug: string, invitationId: string, signal?: AbortSignal): Promise<Outcome<IssuedInvitation>>;
  revokeInvitation(slug: string, invitationId: string, signal?: AbortSignal): Promise<Outcome<true>>;
  /** `stepDown` also makes the caller an ADMIN. The caller sends it only after the person confirmed in the UI. */
  transferOwnership(slug: string, membershipId: string, stepDown: boolean, signal?: AbortSignal): Promise<Outcome<MemberData>>;
  stepDown(slug: string, signal?: AbortSignal): Promise<Outcome<MemberData>>;
  leave(slug: string, signal?: AbortSignal): Promise<Outcome<true>>;

  // ---- Roles and access (A2-C). Read-only description; there is no write route and no custom roles. ----
  accessRoles(slug: string, signal?: AbortSignal): Promise<Outcome<AccessModelData>>;
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
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  /** One answer for every call: no response, a rule violation (400), a classified status, then the validated body. */
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) return { kind: 'invalid_input', message: (raw.json as { message?: string } | undefined)?.message ?? 'Please check the details and try again.' };
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  /** A write: the input is checked against the shared contract first, so a stray field is never sent. */
  async function mutate<S extends z.ZodType, T>(method: 'POST' | 'PATCH', path: string, request: z.ZodType, input: unknown, response: S, pick: (data: z.infer<S>) => T, signal?: AbortSignal): Promise<Outcome<T>> {
    const checked = request.safeParse(input);
    if (!checked.success) return { kind: 'invalid_input', message: checked.error.issues[0]?.message ?? 'Check the details.', fields: fieldErrors(checked.error) };
    return settle(await http.request(method, path, checked.data, signal), response, pick);
  }
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
    async members(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listMembers.path, { slug }), undefined, signal), MembersResponse, (d) => d.members);
    },
    async changeRole(slug, membershipId, role, signal) {
      return mutate('PATCH', p(endpoints.changeMemberRole.path, { slug, membershipId }), UpdateMemberRequest, { role }, MemberResponse, (d) => d.member, signal);
    },
    async setMemberStatus(slug, membershipId, status, signal) {
      return mutate('PATCH', p(endpoints.changeMemberRole.path, { slug, membershipId }), UpdateMemberRequest, { status }, MemberResponse, (d) => d.member, signal);
    },
    async removeMember(slug, membershipId, signal) {
      return settle(await http.request('DELETE', p(endpoints.removeMember.path, { slug, membershipId }), undefined, signal), OkResponse, () => true as const);
    },
    async invitations(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listInvitations.path, { slug }), undefined, signal), InvitationsResponse, (d) => d.invitations);
    },
    async invite(slug, input, signal) {
      return mutate('POST', p(endpoints.createInvitation.path, { slug }), CreateInvitationRequest, input, InvitationResponse, (d) => d, signal);
    },
    async resendInvitation(slug, invitationId, signal) {
      return settle(await http.request('POST', p(endpoints.resendInvitation.path, { slug, invitationId }), undefined, signal), InvitationResponse, (d) => d);
    },
    async revokeInvitation(slug, invitationId, signal) {
      return settle(await http.request('DELETE', p(endpoints.revokeInvitation.path, { slug, invitationId }), undefined, signal), OkResponse, () => true as const);
    },
    async transferOwnership(slug, membershipId, stepDown, signal) {
      return mutate('POST', p(endpoints.transferOwnership.path, { slug, membershipId }), TransferOwnershipRequest, { stepDown, confirm: true }, MemberResponse, (d) => d.member, signal);
    },
    async stepDown(slug, signal) {
      return mutate('POST', p(endpoints.stepDownAsOwner.path, { slug }), ConfirmRequest, { confirm: true }, MemberResponse, (d) => d.member, signal);
    },
    async leave(slug, signal) {
      return mutate('POST', p(endpoints.leaveBusiness.path, { slug }), ConfirmRequest, { confirm: true }, OkResponse, () => true as const, signal);
    },
    async accessRoles(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listAccessRoles.path, { slug }), undefined, signal), AccessRolesResponse, (d) => d);
    },
  };
}
