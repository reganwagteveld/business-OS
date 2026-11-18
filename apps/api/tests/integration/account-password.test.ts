/**
 * Account management component 2: password change while signed in (Settings A3-A, settings-a3 §10.2, §15.3,
 * §15.4). POST /api/v1/me/password needs the current password, ends every other session (browser and desktop),
 * invalidates outstanding reset links, is rate-limited and audited without any secret.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChangePasswordResponse } from '@business-os/contracts';
import { ACCOUNT_RATE_LIMITS } from '@/modules/identity/server/account-support';
import { account, desktopSession, identityEvents, PASSWORD, person, requestReset, sessionIdOf, signIn, stillSignedIn } from './support/account';

const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
beforeAll(() => admin.connect());
afterAll(() => admin.end());

const NEW_PASSWORD = 'a completely different passphrase';
const change = (cookie: string, body: unknown, extra: { origin?: string | null } = {}) => account('POST', '/api/v1/me/password', { cookie, body, ...extra });
const passwordHash = async (userId: string) => (await admin.query("SELECT password FROM accounts WHERE user_id = $1 AND provider_id = 'credential'", [userId])).rows[0].password as string;

describe('POST /api/v1/me/password', () => {
  it('changes the password, keeps this session, ends every other browser and desktop session', async () => {
    const me = await person(admin);
    const otherBrowser = (await signIn(me.email))!;
    const desktop = await desktopSession(admin, me.id);
    const bystander = await person(admin);
    const before = await passwordHash(me.id);

    const res = await change(me.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(ChangePasswordResponse.parse(await res.json())).toEqual({ otherSessionsEnded: 2 });

    expect(await stillSignedIn({ cookie: me.cookie })).toBe(true);
    expect(await stillSignedIn({ cookie: otherBrowser })).toBe(false);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(false);
    expect(await stillSignedIn({ cookie: bystander.cookie })).toBe(true);
    const after = await passwordHash(me.id);
    expect(after).not.toBe(before);
    expect(after).not.toContain(NEW_PASSWORD);

    expect(await signIn(me.email, PASSWORD)).toBeNull();
    expect(await signIn(me.email, NEW_PASSWORD)).not.toBeNull();

    const events = await identityEvents(admin, me.id);
    expect(events.map((e) => e.action)).toEqual(['identity.password.changed']);
    expect(events[0]!.metadata).toEqual({ otherSessionsEnded: 2, actorSessionId: await sessionIdOf(admin, me.cookie) });
    const text = JSON.stringify(events);
    for (const secret of [PASSWORD, NEW_PASSWORD, before, after, me.email]) expect(text).not.toContain(secret);
  });

  it('refuses a wrong current password, changes nothing, ends nothing, and records the failure without detail', async () => {
    const me = await person(admin);
    const otherBrowser = (await signIn(me.email))!;
    const before = await passwordHash(me.id);
    const res = await change(me.cookie, { currentPassword: 'not my password at all', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_password');
    expect(await passwordHash(me.id)).toBe(before);
    expect(await stillSignedIn({ cookie: otherBrowser })).toBe(true);
    const events = await identityEvents(admin, me.id);
    expect(events.map((e) => e.action)).toEqual(['identity.password.change_failed']);
    expect(events[0]!.metadata).toEqual({ reason: 'invalid_password', actorSessionId: expect.any(String) });
    expect(JSON.stringify(events)).not.toContain('not my password at all');
  });

  it('refuses the same password, weak or overlong passwords and extra fields', async () => {
    const me = await person(admin);
    const before = await passwordHash(me.id);
    const same = await change(me.cookie, { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect((await same.json()).error).toBe('password_unchanged');
    for (const body of [
      { currentPassword: PASSWORD, newPassword: 'short' },
      { currentPassword: PASSWORD, newPassword: 'x'.repeat(129) },
      { currentPassword: '', newPassword: NEW_PASSWORD },
      { newPassword: NEW_PASSWORD },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, revokeOtherSessions: false },
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, userId: me.id },
    ]) expect((await change(me.cookie, body)).status, JSON.stringify(Object.keys(body))).toBe(400);
    expect(await passwordHash(me.id)).toBe(before);
  });

  it('invalidates an outstanding password-reset link', async () => {
    const me = await person(admin);
    await requestReset(me.email);
    const pending = await admin.query("SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-password:%' AND value = $1", [me.id]);
    expect(pending.rows[0].n).toBe(1);
    expect((await change(me.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM verifications WHERE identifier LIKE 'reset-password:%' AND value = $1", [me.id]);
    expect(rows[0].n).toBe(0);
  });

  it('requires a session, the app Origin for cookies, and admission', async () => {
    const me = await person(admin);
    const before = await passwordHash(me.id);
    const body = { currentPassword: PASSWORD, newPassword: NEW_PASSWORD };
    expect((await account('POST', '/api/v1/me/password', { body })).status).toBe(401);
    expect((await change(me.cookie, body, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await change(me.cookie, body, { origin: null })).status).toBe(403);
    const outsider = await person(admin, { admitted: false });
    const denied = await change(outsider.cookie, body);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'invite_required' });
    expect(await passwordHash(me.id)).toBe(before);
  });

  it('works from the desktop client and then ends the browser sessions', async () => {
    const me = await person(admin);
    const desktop = await desktopSession(admin, me.id);
    const res = await account('POST', '/api/v1/me/password', { bearer: desktop.bearer, origin: null, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await stillSignedIn({ bearer: desktop.bearer })).toBe(true);
    expect(await stillSignedIn({ cookie: me.cookie })).toBe(false);
  });

  it('counts right and wrong attempts against one per-account limit', async () => {
    const me = await person(admin);
    const { max } = ACCOUNT_RATE_LIMITS.password;
    for (let i = 0; i < max; i++) expect((await change(me.cookie, { currentPassword: `wrong guess ${i}`, newPassword: NEW_PASSWORD })).status).toBe(400);
    const limited = await change(me.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(limited.status).toBe(429);
    expect(await signIn(me.email, PASSWORD)).not.toBeNull();
  });

  it('lets only one of two concurrent changes from two devices win', async () => {
    const me = await person(admin);
    const second = (await signIn(me.email))!;
    const [a, b] = await Promise.all([
      change(me.cookie, { currentPassword: PASSWORD, newPassword: 'first new passphrase here' }),
      change(second, { currentPassword: PASSWORD, newPassword: 'second new passphrase here' }),
    ]);
    const statuses = [a.status, b.status].sort();
    // The winner ends the loser's session; the loser either finds its password check stale or its session gone.
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    const winners = await identityEvents(admin, me.id);
    expect(winners.filter((e) => e.action === 'identity.password.changed')).toHaveLength(1);
  });

  it('rolls everything back when the audit row cannot be written (fail closed)', async () => {
    const me = await person(admin);
    const otherBrowser = (await signIn(me.email))!;
    const before = await passwordHash(me.id);
    const fn = `test_block_audit_${me.id.replace(/-/g, '')}`;
    await admin.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.actor_user_id = '${me.id}' AND NEW.action = 'identity.password.changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      expect((await change(me.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(500);
    } finally {
      await admin.query(`DROP TRIGGER ${fn} ON audit_events`);
      await admin.query(`DROP FUNCTION ${fn}()`);
    }
    expect(await passwordHash(me.id)).toBe(before);
    expect(await stillSignedIn({ cookie: otherBrowser })).toBe(true);
  });
});
