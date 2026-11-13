import type { CurrentUser } from '@business-os/contracts';
import { useEffect, useMemo, useState } from 'react';
import { createAuthClient, type AuthClient, type AuthTransport } from './api/auth';
import { createApiClient, type ApiClient } from './api/client';
import { AcceptInvitation, AuthScreens, DesktopSignIn, type AuthView } from './auth/auth-screens';
import type { ClientPlatform } from './config';
import { Workspace, Startup } from './shell/workspace';
import { createWorkspaceClient } from './api/workspace';
import { useApiStatus } from './shell/use-api-status';

export interface AppProps {
  platform: ClientPlatform;
  apiBaseUrl: string;
  /** How this client authenticates: cookie (browser app) or bearer from the OS credential store (desktop). */
  transport?: AuthTransport;
  /** Browser app only: the current path and query, used for /sign-in?next=… and /reset-password?token=…. */
  location?: { pathname: string; search: string };
  /** Browser app only: full-page navigation (used to resume a desktop sign-in after signing in). */
  navigate?: (url: string) => void;
  /** Browser app only: replaces the address-bar path without reloading (drops one-time tokens from the URL). */
  replaceLocation?: (path: string) => void;
  /** Injected in tests; production uses the default fetch-based clients. */
  client?: ApiClient;
  auth?: AuthClient;
}

// After a browser sign-in, only the desktop authorisation page may be resumed (no open redirects).
const SAFE_NEXT = /^\/api\/v1\/auth\/desktop\/authorize\?[A-Za-z0-9_\-.=&%]+$/;

type SessionState = { state: 'loading' } | { state: 'signed-out' } | { state: 'signed-in'; user: CurrentUser };

/** The shared client application, rendered identically by apps/desktop and apps/web. */
export function App({ platform, apiBaseUrl, transport, location, navigate, replaceLocation, client, auth: authOverride }: AppProps) {
  const api = useMemo(() => client ?? createApiClient(apiBaseUrl), [client, apiBaseUrl]);
  const auth = useMemo(() => authOverride ?? createAuthClient(apiBaseUrl, transport ?? { kind: 'cookie' }), [authOverride, apiBaseUrl, transport]);
  const status = useApiStatus(api);
  const workspace = useMemo(() => createWorkspaceClient(apiBaseUrl, auth), [apiBaseUrl, auth]);
  const [session, setSession] = useState<SessionState>({ state: 'loading' });

  const params = new URLSearchParams(location?.search ?? '');
  const next = params.get('next');
  // Invitation links (/invite?token=…) open the accept screen after sign-in. The token is read once
  // and removed from the address bar so it does not stay in history or get shared by accident.
  const [inviteToken] = useState(() => (location?.pathname === '/invite' ? params.get('token') : null));
  const [inviteDone, setInviteDone] = useState(location?.pathname !== '/invite');
  useEffect(() => {
    if (location?.pathname === '/invite' && replaceLocation) replaceLocation('/invite');
  }, [location?.pathname, replaceLocation]);
  // Bumped after sign-in or sign-out to re-read the session from the API.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  useEffect(() => {
    let cancelled = false;
    void auth.me().then((user) => {
      if (cancelled) return;
      if (user && next && SAFE_NEXT.test(next) && navigate) navigate(next);
      else setSession(user ? { state: 'signed-in', user } : { state: 'signed-out' });
    });
    return () => {
      cancelled = true;
    };
  }, [auth, next, navigate, version]);

  if (session.state === 'loading') return <Startup />;
  if (session.state === 'signed-out') {
    if (status.state === 'unreachable') return <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"><h1 className="text-2xl font-semibold">Cannot connect to Business OS</h1><p role="alert" className="text-sm text-muted-foreground">{status.reason}</p><button className="rounded-lg border px-4 py-2" type="button" onClick={refresh}>Retry connection</button></main>;
    if (platform === 'desktop') return <DesktopSignIn auth={auth} onSignedIn={refresh} />;
    const initialView: AuthView = location?.pathname === '/reset-password' ? 'reset' : inviteToken ? 'sign-up' : 'sign-in';
    return <AuthScreens auth={auth} initialView={initialView} resetToken={params.get('token')} onSignedIn={refresh} />;
  }
  if (!inviteDone) {
    return (
      <AcceptInvitation
        auth={auth}
        token={inviteToken}
        email={session.user.email}
        onDone={() => {
          setInviteDone(true);
          replaceLocation?.('/');
        }}
      />
    );
  }
  return (
    <Workspace
      user={session.user}
      client={workspace}
      onSignOut={async () => {
        await auth.signOut();
        refresh();
      }}
    />
  );
}
