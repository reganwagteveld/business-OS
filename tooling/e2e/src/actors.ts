// Users, businesses and role teams, all created through the real HTTP API (only the beta-admission and
// email-verification fixtures touch the database directly).
import { randomUUID } from 'node:crypto';
import { admitForSignup, grantBusinessCreation, markEmailVerified, one, planInvitationToken } from './db';
import { Client } from './http';

export const PASSWORD = 'correct horse battery staple';
export type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';

export class Actor extends Client {
  constructor(readonly email: string, readonly id: string) {
    super();
  }
  /** Tenant-scoped path helper. */
  b(slug: string, path = ''): string {
    return `/api/v1/b/${slug}${path}`;
  }
}

export async function newUser(prefix: string): Promise<Actor> {
  const email = `${prefix}-${randomUUID().slice(0, 12)}@example.com`;
  await admitForSignup(email);
  const c = new Client();
  const up = await c.post('/api/v1/auth/sign-up/email', { email, password: PASSWORD, name: prefix });
  if (up.status >= 400) throw new Error(`sign-up failed: ${up.status} ${JSON.stringify(up.body)}`);
  await markEmailVerified(email);
  await grantBusinessCreation(email);
  const actor = new Actor(email, (await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).id);
  const inn = await actor.post('/api/v1/auth/sign-in/email', { email, password: PASSWORD });
  if (inn.status !== 200 || !actor.hasSession()) throw new Error(`sign-in failed: ${inn.status} ${JSON.stringify(inn.body)}`);
  return actor;
}

export interface Team {
  slug: string;
  businessId: string;
  people: Record<Role, Actor>;
}

/** A business with one person per role. Invitations are created and accepted through the API. */
export async function newTeam(label: string, currency = 'AUD'): Promise<Team> {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await owner.post('/api/v1/businesses', { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency });
  if (created.status !== 201) throw new Error(`business creation failed: ${created.status} ${JSON.stringify(created.body)}`);
  const people = { OWNER: owner } as Record<Role, Actor>;
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER'] as const) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    const invited = await owner.post(`/api/v1/b/${slug}/invitations`, { email: user.email, role });
    if (invited.status !== 201) throw new Error(`invite failed: ${invited.status} ${JSON.stringify(invited.body)}`);
    const token = await planInvitationToken(user.email, slug);
    const accepted = await user.post('/api/v1/invitations/accept', { token });
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    people[role] = user;
  }
  const { id } = await one<{ id: string }>('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, businessId: id, people };
}
