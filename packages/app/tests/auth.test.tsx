import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createAuthClient, type AuthTransport } from '../src';
import { AuthScreens, DesktopSignIn } from '../src/auth/auth-screens';

const user = { id: '0b8f9a9e-2f1c-4c7e-9a52-0c7f6d1b2a10', email: 'a@example.com', name: 'A', emailVerified: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createAuthClient', () => {
  it('browser app: relies on the cookie and never sends a bearer token', async () => {
    const fetchMock = vi.fn(async () => json({ user }));
    const auth = createAuthClient('https://app.example.test', { kind: 'cookie' }, fetchMock);
    expect(await auth.me()).toEqual(user);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('desktop app: sends the token from the credential store as a bearer, without cookies', async () => {
    const fetchMock = vi.fn(async () => json({ user }));
    const transport: AuthTransport = { kind: 'bearer', getToken: async () => 'tok.sig', signIn: vi.fn(), forget: vi.fn() };
    await createAuthClient('https://api.example.test', transport, fetchMock).me();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok.sig');
  });

  it('sign-out on desktop also forgets the stored token', async () => {
    const forget = vi.fn(async () => {});
    const auth = createAuthClient('https://api.example.test', { kind: 'bearer', getToken: async () => 't.s', signIn: vi.fn(), forget }, vi.fn(async () => json({})));
    await auth.signOut();
    expect(forget).toHaveBeenCalledOnce();
  });

  it('validates input before sending and uses generic, non-enumerating messages', async () => {
    const fetchMock = vi.fn(async () => json({ code: 'INVALID_EMAIL_OR_PASSWORD' }, 401));
    const auth = createAuthClient('https://app.example.test', { kind: 'cookie' }, fetchMock);
    expect(await auth.signUp({ email: 'a@example.com', password: 'short', name: 'A' })).toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await auth.signIn({ email: 'a@example.com', password: 'x' })).toEqual({ ok: false, status: 401, message: 'Email or password is incorrect.' });
  });

  it('treats a 401 from /me as signed out and a contract mismatch as signed out', async () => {
    expect(await createAuthClient('https://x.test', { kind: 'cookie' }, vi.fn(async () => json({}, 401))).me()).toBeNull();
    expect(await createAuthClient('https://x.test', { kind: 'cookie' }, vi.fn(async () => json({ user: { id: 1 } }))).me()).toBeNull();
  });
});

describe('auth screens', () => {
  const auth = createAuthClient('https://x.test', { kind: 'cookie' }, vi.fn());
  it('browser app shows email and password sign-in', () => {
    const html = renderToStaticMarkup(<AuthScreens auth={auth} initialView="sign-in" onSignedIn={() => {}} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('Forgot password?');
  });
  it('desktop app never asks for a password: it hands sign-in to the system browser', () => {
    const desktop = createAuthClient('https://x.test', { kind: 'bearer', getToken: async () => null, signIn: vi.fn(), forget: vi.fn() }, vi.fn());
    const html = renderToStaticMarkup(<DesktopSignIn auth={desktop} onSignedIn={() => {}} />);
    expect(html).toContain('Sign in with your browser');
    expect(html).not.toContain('type="password"');
  });
});

describe('desktop transport (PKCE + loopback + credential store)', async () => {
  const { createDesktopTransport, createPkce } = await import('../src');
  it('creates an S256 challenge that matches the verifier', async () => {
    const { verifier, challenge } = await createPkce();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(challenge).toBe(Buffer.from(digest).toString('base64url'));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exchanges the loopback code with the verifier and stores the token only via the native store', async () => {
    const stored: string[] = [];
    let opened = '';
    const native = {
      awaitBrowserSignIn: vi.fn(async (url: string, state: string) => {
        opened = url;
        return { code: 'c'.repeat(43), state, redirect_uri: 'http://127.0.0.1:5555/callback' };
      }),
      loadToken: vi.fn(async () => null),
      storeToken: vi.fn(async (t: string) => void stored.push(t)),
      forgetToken: vi.fn(async () => {}),
    };
    const token = `${'t'.repeat(32)}.${'s'.repeat(43)}=`;
    const fetchMock = vi.fn(async () => json({ token, expiresAt: new Date().toISOString() }));
    const transport = createDesktopTransport('https://api.example.test', native, fetchMock);
    if (transport.kind !== 'bearer') throw new Error('expected bearer transport');
    await transport.signIn();
    const url = new URL(opened);
    expect(url.pathname).toBe('/api/v1/auth/desktop/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier)));
    expect(Buffer.from(digest).toString('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(stored).toEqual([token]);
    expect(await transport.getToken()).toBe(token);
  });

  it('refuses a callback whose state does not match', async () => {
    const native = {
      awaitBrowserSignIn: vi.fn(async () => ({ code: 'c'.repeat(43), state: 'other', redirect_uri: 'http://127.0.0.1:1/callback' })),
      loadToken: vi.fn(async () => null),
      storeToken: vi.fn(),
      forgetToken: vi.fn(),
    };
    const transport = createDesktopTransport('https://api.example.test', native, vi.fn());
    await expect(transport.kind === 'bearer' ? transport.signIn() : Promise.resolve()).rejects.toThrow();
    expect(native.storeToken).not.toHaveBeenCalled();
  });
});

describe('invitation acceptance', () => {
  it('posts the token with the cookie, and returns the business on success', async () => {
    const fetchMock = vi.fn(async () => json({ business: { slug: 'acme', role: 'MEMBER' } }));
    const result = await createAuthClient('https://app.example.test', { kind: 'cookie' }, fetchMock).acceptInvitation('a'.repeat(43));
    expect(result).toEqual({ ok: true, data: { slug: 'acme', role: 'MEMBER' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.example.test/api/v1/invitations/accept');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ token: 'a'.repeat(43) });
  });

  it('gives one generic message for every failure, and never calls the API for a malformed token', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'invitation_invalid' }, 400));
    const auth = createAuthClient('https://app.example.test', { kind: 'cookie' }, fetchMock);
    const wrong = await auth.acceptInvitation('b'.repeat(43));
    expect(wrong).toMatchObject({ ok: false, status: 400 });
    const malformed = await auth.acceptInvitation('not a token!');
    expect(malformed).toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (!wrong.ok && !malformed.ok) expect(wrong.message).toBe(malformed.message);
  });

  it('asks the signed-in user to confirm; it never accepts automatically', async () => {
    const { AcceptInvitation } = await import('../src/auth/auth-screens');
    const auth = createAuthClient('https://x.test', { kind: 'cookie' }, vi.fn());
    const html = renderToStaticMarkup(<AcceptInvitation auth={auth} token={'c'.repeat(43)} email="a@example.com" onDone={() => {}} />);
    expect(html).toContain('Accept invitation');
    expect(html).toContain('a@example.com');
    const missing = renderToStaticMarkup(<AcceptInvitation auth={auth} token={null} email="a@example.com" onDone={() => {}} />);
    expect(missing).toContain('incomplete');
  });
});
