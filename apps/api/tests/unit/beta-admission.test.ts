import { beforeEach, describe, expect, it, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { admissionHooks } from '@/modules/identity/server/admission';
import { betaCanRegister, betaCanSignIn } from '@/core/db';

vi.mock('@/core/db', () => ({ betaCanRegister: vi.fn(), betaCanSignIn: vi.fn() }));

beforeEach(() => vi.resetAllMocks());
function auth() {
  const db = { user: [], session: [], account: [], verification: [] };
  return { db, instance: betterAuth({
    baseURL: 'https://beta.test', secret: 'unit-test-secret-with-at-least-32-characters',
    database: memoryAdapter(db), databaseHooks: admissionHooks,
    emailAndPassword: { enabled: true, autoSignIn: false }, telemetry: { enabled: false },
  }) };
}

describe('admission at the real Better Auth lifecycle boundary', () => {
  it('blocks direct email signup without writing an account', async () => {
    vi.mocked(betaCanRegister).mockResolvedValue(false);
    const { db, instance } = auth();
    const result = await instance.api.signUpEmail({ body: { email: 'stranger@example.com', name: 'S', password: 'secure-password-123' } });
    expect(result.token).toBeNull(); // Better Auth masks denied signup to avoid enumeration.
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
  });

  it.each(['google', 'github'])('blocks %s first-login even with a provider-verified email', async (providerId) => {
    vi.mocked(betaCanRegister).mockResolvedValue(false);
    const { db, instance } = auth();
    const ctx = await instance.$context;
    await expect(ctx.internalAdapter.createOAuthUser(
      { email: 'stranger@example.com', name: 'S', emailVerified: true },
      { providerId, accountId: 'external-id' },
    )).rejects.toMatchObject({ status: 'FORBIDDEN' });
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
    expect(db.session).toHaveLength(0);
  });

  it('allows invited signup and authorised sign-in, then blocks new sessions after revocation', async () => {
    vi.mocked(betaCanRegister).mockResolvedValue(true);
    vi.mocked(betaCanSignIn).mockResolvedValue(true);
    const { instance } = auth();
    const result = await instance.api.signUpEmail({ body: { email: 'invited@example.com', name: 'I', password: 'secure-password-123' } });
    const signedIn = await instance.api.signInEmail({ body: { email: 'invited@example.com', password: 'secure-password-123' } });
    expect(signedIn.user.id).toBe(result.user.id);
    vi.mocked(betaCanSignIn).mockResolvedValue(false);
    await expect(instance.api.signInEmail({ body: { email: 'invited@example.com', password: 'secure-password-123' } })).rejects.toMatchObject({ status: 'FORBIDDEN' });
  });

  it('fails closed when the admission database is unavailable', async () => {
    vi.mocked(betaCanRegister).mockRejectedValue(new Error('unavailable'));
    const { db, instance } = auth();
    await expect((await instance.$context).internalAdapter.createUser({ email: 'a@example.com', name: 'A', emailVerified: true }, { method: 'email-password' })).rejects.toThrow();
    expect(db.user).toHaveLength(0);
  });
});
