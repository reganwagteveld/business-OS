/**
 * Account management component 1: display name (Settings A3-A, settings-a3 §7.1, §15.2, §15.4).
 * PATCH /api/v1/me changes only the signed-in person's own name, with CSRF, admission, a rate limit and an
 * audit row that carries no values.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UpdateProfileResponse } from '@business-os/contracts';
import { ACCOUNT_RATE_LIMITS } from '@/modules/identity/server/account-support';
import { account, desktopSession, identityEvents, person } from './support/account';

const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
beforeAll(() => admin.connect());
afterAll(() => admin.end());

describe('PATCH /api/v1/me (display name)', () => {
  it('changes only the caller’s own name and records a value-free audit event', async () => {
    const me = await person(admin, { name: 'Old Name' });
    const other = await person(admin, { name: 'Someone Else' });
    const res = await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: '  Ada Lovelace  ' } });
    expect(res.status).toBe(200);
    const body = UpdateProfileResponse.parse(await res.json());
    expect(body.user).toEqual({ id: me.id, email: me.email, name: 'Ada Lovelace', emailVerified: true });
    const { rows } = await admin.query('SELECT id, name FROM users WHERE id = ANY($1) ORDER BY name', [[me.id, other.id]]);
    expect(rows.map((r) => r.name).sort()).toEqual(['Ada Lovelace', 'Someone Else']);

    const events = await identityEvents(admin, me.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'identity.profile.name_changed', business_id: null, target_type: 'user', target_id: me.id });
    expect(events[0]!.metadata).toEqual({ fields: ['name'], actorSessionId: expect.any(String) });
    expect(JSON.stringify(events[0])).not.toMatch(/Ada|Old Name|example\.com/);
  });

  it('works for the desktop client with its bearer token', async () => {
    const me = await person(admin);
    const desktop = await desktopSession(admin, me.id);
    const res = await account('PATCH', '/api/v1/me', { bearer: desktop.bearer, origin: null, body: { name: 'From the desktop' } });
    expect(res.status).toBe(200);
    expect((await identityEvents(admin, me.id))[0]!.metadata.actorSessionId).toBe(desktop.id);
  });

  it('writes nothing and records nothing when the name is unchanged', async () => {
    const me = await person(admin, { name: 'Same Name' });
    const res = await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: 'Same Name' } });
    expect(res.status).toBe(200);
    expect(await identityEvents(admin, me.id)).toEqual([]);
  });

  it('refuses invalid names and any extra field (no user id, email or image from the client)', async () => {
    const me = await person(admin, { name: 'Kept' });
    for (const body of [
      { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 'bad\u0000name' }, { name: 'spoof‮eman' }, {},
      { name: 'Ok', email: 'attacker@example.com' }, { name: 'Ok', id: randomUUID() }, { name: 'Ok', imageUrl: 'https://x' },
    ]) {
      const res = await account('PATCH', '/api/v1/me', { cookie: me.cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const { rows } = await admin.query('SELECT name, email FROM users WHERE id = $1', [me.id]);
    expect(rows[0]).toEqual({ name: 'Kept', email: me.email });
  });

  it('requires a session, the app Origin for cookies, and admission', async () => {
    const me = await person(admin);
    expect((await account('PATCH', '/api/v1/me', { body: { name: 'Nobody' } })).status).toBe(401);
    expect((await account('PATCH', '/api/v1/me', { cookie: me.cookie, origin: 'https://evil.example', body: { name: 'CSRF' } })).status).toBe(403);
    expect((await account('PATCH', '/api/v1/me', { cookie: me.cookie, origin: null, body: { name: 'No origin' } })).status).toBe(403);
    expect((await account('PATCH', '/api/v1/me', { bearer: 'not.a-valid-token', origin: null, body: { name: 'Forged' } })).status).toBe(401);
    const outsider = await person(admin, { admitted: false });
    const denied = await account('PATCH', '/api/v1/me', { cookie: outsider.cookie, body: { name: 'Not admitted' } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'invite_required' });
    const { rows } = await admin.query('SELECT name FROM users WHERE id = ANY($1)', [[me.id, outsider.id]]);
    expect(rows.map((r) => r.name)).toEqual(['Test Person', 'Test Person']);
  });

  it('is rate-limited per account', async () => {
    const me = await person(admin);
    const { max } = ACCOUNT_RATE_LIMITS.profile;
    for (let i = 0; i < max; i++) expect((await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: `Name ${i}` } })).status).toBe(200);
    const limited = await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: 'One too many' } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    // Another person is unaffected.
    const other = await person(admin);
    expect((await account('PATCH', '/api/v1/me', { cookie: other.cookie, body: { name: 'Fine' } })).status).toBe(200);
  });

  it('rolls the change back when the audit row cannot be written (fail closed)', async () => {
    const me = await person(admin, { name: 'Before' });
    // A trigger that refuses this person's identity audit rows stands in for an audit outage.
    const fn = `test_block_audit_${me.id.replace(/-/g, '')}`;
    await admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.actor_user_id = '${me.id}' AND NEW.action LIKE 'identity.%' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const res = await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: 'After' } });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal_error' });
    } finally {
      await admin.query(`DROP TRIGGER ${fn} ON audit_events`);
      await admin.query(`DROP FUNCTION ${fn}()`);
    }
    const { rows } = await admin.query('SELECT name FROM users WHERE id = $1', [me.id]);
    expect(rows[0].name).toBe('Before');
  });
});

describe('identity audit rows', () => {
  it('are platform rows that no runtime role can read, change or delete', async () => {
    const me = await person(admin);
    await account('PATCH', '/api/v1/me', { cookie: me.cookie, body: { name: 'Audited' } });
    for (const url of [process.env.DATABASE_URL!, process.env.AUTH_DATABASE_URL!]) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const read = await client.query("SELECT count(*)::int AS n FROM audit_events WHERE action LIKE 'identity.%'").then((r) => r.rows[0].n as number, () => 'denied');
        expect(read === 'denied' || read === 0).toBe(true);
        await expect(client.query("UPDATE audit_events SET action = 'x' WHERE action LIKE 'identity.%'")).rejects.toThrow();
        await expect(client.query("DELETE FROM audit_events WHERE action LIKE 'identity.%'")).rejects.toThrow();
      } finally {
        await client.end();
      }
    }
    expect(await identityEvents(admin, me.id)).toHaveLength(1);
  });
});
