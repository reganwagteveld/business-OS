// Direct PostgreSQL access for fixtures and assertions. The API under test never uses these connections.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { env } from './env';

/** Superuser on the disposable database: seeds test fixtures and reads back what the API persisted. */
export const admin = new pg.Client({ connectionString: env.adminDbUrl });
let adminConnected: Promise<unknown> | undefined;
export const connectAdmin = async (): Promise<void> => {
  await (adminConnected ??= admin.connect());
};
export const closeAdmin = async () => {
  if (adminConnected) await admin.end();
  adminConnected = undefined;
};

/** One row, or fail loudly. */
export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { rows } = await admin.query<T>(sql, params);
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}: ${sql}`);
  return rows[0]!;
}

/** Test-only fixture: operator admission for beta sign-up (an invitation) and the business-creation grant. */
export async function admitForSignup(email: string): Promise<void> {
  const inviter = randomUUID();
  const businessId = randomUUID();
  await admin.query('INSERT INTO users (id, email, email_verified, name, updated_at) VALUES ($1, $2, true, $3, now())', [inviter, `${inviter}@example.com`, 'Fixture inviter']);
  await admin.query(
    `INSERT INTO businesses (id, name, slug, country_code, time_zone, locale, currency, home_region) VALUES ($1, 'Invitation fixture', $2, 'US', 'UTC', 'en-US', 'USD', 'e2e')`,
    [businessId, `invite-fixture-${randomUUID().slice(0, 8)}`],
  );
  await admin.query(
    `INSERT INTO invitations (id, business_id, email, role, token_hash, invited_by_id, expires_at) VALUES ($1, $2, $3, 'MEMBER', $4, $5, now() + interval '1 day')`,
    [randomUUID(), businessId, email.toLowerCase(), createHash('sha256').update(randomUUID()).digest('hex'), inviter],
  );
}
export async function grantBusinessCreation(email: string): Promise<void> {
  await admin.query(
    `INSERT INTO app_private.beta_admissions (user_id, source, can_create_business) SELECT id, 'e2e-fixture', true FROM users WHERE email = lower($1) ON CONFLICT DO NOTHING`,
    [email],
  );
}
/** Email delivery is not exercised (no outbound email): the verified flag is set directly. */
export async function markEmailVerified(email: string): Promise<void> {
  await admin.query('UPDATE users SET email_verified = true WHERE email = lower($1)', [email]);
}
/**
 * Invitation emails are never sent, so their one-time token is unobservable. The fixture replaces the stored
 * token hash with the hash of a token it knows, then the real accept endpoint is called with that token.
 */
export async function planInvitationToken(email: string, businessSlug: string): Promise<string> {
  const token = randomUUID() + randomUUID();
  const { rowCount } = await admin.query(
    `UPDATE invitations SET token_hash = $1 WHERE lower(email) = lower($2) AND accepted_at IS NULL AND business_id = (SELECT id FROM businesses WHERE slug = $3)`,
    [createHash('sha256').update(token).digest('hex'), email, businessSlug],
  );
  if (rowCount !== 1) throw new Error(`expected one pending invitation for ${email}, found ${rowCount}`);
  return token;
}
