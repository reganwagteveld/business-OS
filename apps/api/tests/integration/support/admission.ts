import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Explicit test-only invitation fixture; never disables production admission checks. */
export async function inviteForSignup(admin: pg.Client, email: string, role: 'ADMIN' | 'MANAGER' | 'MEMBER' = 'MEMBER') {
  const businessId = randomUUID();
  const inviter = randomUUID();
  const token = randomUUID() + randomUUID();
  const invitationId = randomUUID();
  const slug = `invite-fixture-${randomUUID().slice(0, 8)}`;
  await admin.query('INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, $3, now())', [inviter, `${inviter}@example.com`, 'Fixture inviter']);
  await admin.query(`INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
    VALUES ($1, 'Invitation fixture', $2, 'US', 'UTC', 'en-US', 'USD', 'ci')`, [businessId, slug]);
  await admin.query(`INSERT INTO invitations (id, business_id, email, role, token_hash, invited_by_id, expires_at)
    VALUES ($1, $2, $3, $6, $4, $5, now() + interval '1 day')`,
  [invitationId, businessId, email.toLowerCase(), createHash('sha256').update(token).digest('hex'), inviter, role]);
  return { token, invitationId, businessId, slug };
}

/**
 * Existing suites exercise admitted business owners: seed their explicit operator approval (admission
 * plus, by default, the business-creation grant) after signup. Pass `canCreateBusiness: false` for an
 * admitted account without the creation grant.
 */
export async function admitFixture(admin: pg.Client, email: string, opts: { canCreateBusiness?: boolean } = {}) {
  await admin.query(`INSERT INTO app_private.beta_admissions (user_id, source, can_create_business)
    SELECT id, 'test-fixture', $2 FROM users WHERE email = lower($1) ON CONFLICT DO NOTHING`, [email, opts.canCreateBusiness ?? true]);
}
