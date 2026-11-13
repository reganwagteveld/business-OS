import { z } from 'zod';
import { Email } from './auth.ts';

// Businesses, memberships and invitations (data-model §4.2–4.4, architecture §7.2). The active
// business is always the `:slug` path segment, resolved and checked on the server; no request body
// ever carries a business id.

export const Role = z.enum(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']);
export type Role = z.infer<typeof Role>;
/** Roles that can be given by invitation: ownership is never handed out by link. */
export const InvitableRole = z.enum(['ADMIN', 'MANAGER', 'MEMBER']);

export const Slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3 to 48 lower-case letters, digits or hyphens');

export const BusinessSummary = z.object({ slug: Slug, name: z.string(), role: Role }).strict();
export const ListBusinessesResponse = z.object({ businesses: z.array(BusinessSummary) }).strict();

export const CreateBusinessRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: Slug,
    countryCode: z.string().regex(/^[A-Z]{2}$/),
    timeZone: z.string().min(1).max(64),
    locale: z.string().min(2).max(35),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export const CreateBusinessResponse = z.object({ business: z.object({ slug: Slug }).strict() }).strict();

export const AcceptInvitationRequest = z.object({ token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();
export const AcceptInvitationResponse = z.object({ business: z.object({ slug: Slug, role: Role }).strict() }).strict();

export const BusinessContextResponse = z
  .object({
    business: z.object({ slug: Slug, name: z.string(), countryCode: z.string(), timeZone: z.string(), locale: z.string(), currency: z.string() }).strict(),
    membership: z.object({ id: z.string().uuid(), role: Role, permissions: z.array(z.string()) }).strict(),
  })
  .strict();

export const Member = z
  .object({ id: z.string().uuid(), userId: z.string().uuid(), name: z.string().nullable(), role: Role, status: z.enum(['ACTIVE', 'SUSPENDED']), createdAt: z.string().datetime() })
  .strict();
export const MembersResponse = z.object({ members: z.array(Member) }).strict();
export const ChangeRoleRequest = z.object({ role: Role }).strict();
export const MemberResponse = z.object({ member: Member }).strict();

export const Invitation = z
  .object({ id: z.string().uuid(), email: z.string(), role: InvitableRole, expiresAt: z.string().datetime(), createdAt: z.string().datetime() })
  .strict();
export const InvitationsResponse = z.object({ invitations: z.array(Invitation) }).strict();
export const CreateInvitationRequest = z.object({ email: Email, role: InvitableRole }).strict();
export const InvitationResponse = z.object({ invitation: Invitation }).strict();

export const OkResponse = z.object({ ok: z.literal(true) }).strict();
