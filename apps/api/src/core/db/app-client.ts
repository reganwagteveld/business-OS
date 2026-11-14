import 'server-only';
// Runtime database access for tenant code (bos_app, DATABASE_URL). Tenant data is reachable only
// through withTenant; the three pre-tenant operations go through the SECURITY DEFINER functions in
// app_private, which bind the caller to a verified session token (data-model §5.3, §5.5).
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { getEnv } from '../config/env';
import { createWithTenant, type TenantDb } from './with-tenant';

let client: PrismaClient | undefined;
function appPrisma(): PrismaClient {
  client ??= new PrismaClient({ adapter: new PrismaPg({ connectionString: getEnv().DATABASE_URL, max: 5 }) });
  return client;
}

/** Tenant models and the column that carries the tenant id. */
const TENANT_MODELS = {
  business: 'id', membership: 'businessId', invitation: 'businessId', auditEvent: 'businessId',
  customer: 'businessId', contact: 'businessId', activity: 'businessId',
  salesPipeline: 'businessId', salesStage: 'businessId', opportunity: 'businessId',
} as const;
type AppTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;
export type AppTenantDb = TenantDb<AppTx, keyof typeof TENANT_MODELS>;

let runner: ReturnType<typeof createWithTenant<AppTx, keyof typeof TENANT_MODELS>> | undefined;
/** Opens one unit of work for a verified tenant context (see ./with-tenant.ts). */
export const withTenant: NonNullable<typeof runner> = (ctx, work, opts) => {
  runner ??= createWithTenant<AppTx, keyof typeof TENANT_MODELS>({ clients: { app: appPrisma() }, models: TENANT_MODELS });
  return runner(ctx, work, opts);
};

export type MembershipRow = { businessId: string; slug: string; name: string; role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER'; membershipId: string };

/** Pre-tenant: the caller's active memberships, resolved from the raw session token in the database. */
export async function myMemberships(sessionToken: string): Promise<MembershipRow[]> {
  const rows = await appPrisma().$queryRaw<{ business_id: string; slug: string; name: string; role: MembershipRow['role']; membership_id: string }[]>`
    SELECT business_id::text, slug, name, role::text AS role, membership_id::text FROM app_private.my_memberships(${sessionToken})`;
  return rows.map((r) => ({ businessId: r.business_id, slug: r.slug, name: r.name, role: r.role, membershipId: r.membership_id }));
}

export interface NewBusiness { name: string; slug: string; countryCode: string; timeZone: string; locale: string; currency: string }

export class TrustedPathError extends Error {
  constructor(readonly reason: 'not_allowed' | 'invalid' | 'slug_unavailable' | 'rate_limited' | 'invitation_invalid') {
    super(reason);
    this.name = 'TrustedPathError';
  }
}

function mapError(error: unknown, fallback: TrustedPathError['reason']): TrustedPathError {
  const code = (error as { meta?: { code?: string }; code?: string })?.meta?.code ?? '';
  const message = error instanceof Error ? error.message : '';
  if (/slug unavailable/.test(message) || code === '23505') return new TrustedPathError('slug_unavailable');
  if (/too many businesses/.test(message) || code === '54000') return new TrustedPathError('rate_limited');
  if (/invalid business details/.test(message) || code === '22023') return new TrustedPathError('invalid');
  return new TrustedPathError(fallback);
}

/** Pre-tenant: creates a business with the caller as OWNER. The region comes from the database. */
export async function createBusiness(sessionToken: string, input: NewBusiness): Promise<{ businessId: string; slug: string }> {
  try {
    const rows = await appPrisma().$queryRaw<{ business_id: string; slug: string }[]>`
      SELECT business_id::text, slug FROM app_private.create_business(
        ${sessionToken}, ${input.name}, ${input.slug}, ${input.countryCode}, ${input.timeZone}, ${input.locale}, ${input.currency})`;
    return { businessId: rows[0]!.business_id, slug: rows[0]!.slug };
  } catch (error) {
    throw mapError(error, 'not_allowed');
  }
}

/** Pre-tenant: accepts an invitation for the caller (verified email must match). Generic failure. */
export async function acceptInvitation(sessionToken: string, inviteToken: string): Promise<{ businessId: string; slug: string; role: MembershipRow['role'] }> {
  try {
    const rows = await appPrisma().$queryRaw<{ business_id: string; slug: string; role: MembershipRow['role'] }[]>`
      SELECT business_id::text, slug, role::text AS role FROM app_private.accept_invitation(${sessionToken}, ${inviteToken})`;
    return { businessId: rows[0]!.business_id, slug: rows[0]!.slug, role: rows[0]!.role };
  } catch {
    throw new TrustedPathError('invitation_invalid');
  }
}
