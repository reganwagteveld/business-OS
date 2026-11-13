import type { CurrentUser } from '@business-os/contracts';
import { useEffect, useMemo, useState } from 'react';
import { createAuthClient, type AuthClient, type AuthTransport } from './api/auth';
import { createApiClient, type ApiClient } from './api/client';
import { AuthScreens, DesktopSignIn, type AuthView } from './auth/auth-screens';
import type { ClientPlatform } from './config';
import { Home } from './shell/home';
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
  /** Injected in tests; production uses the default fetch-based clients. */
  client?: ApiClient;
  auth?: AuthClient;
}

// After a browser sign-in, only the desktop authorisation page may be resumed (no open redirects).
const SAFE_NEXT = /^\/api\/v1\/auth\/desktop\/authorize\?[A-Za-z0-9_\-.=&%]+$/;

type SessionState = { state: 'loading' } | { state: 'signed-out' } | { state: 'signed-in'; user: CurrentUser };

/** The shared client application, rendered identically by apps/desktop and apps/web. */
export function App({ platform, apiBaseUrl, transport, location, navigate, client, auth: authOverride }: AppProps) {
  const api = useMemo(() => client ?? createApiClient(apiBaseUrl), [client, apiBaseUrl]);
  const auth = useMemo(() => authOverride ?? createAuthClient(apiBaseUrl, transport ?? { kind: 'cookie' }), [authOverride, apiBaseUrl, transport]);
  const status = useApiStatus(api);
  const [session, setSession] = useState<SessionState>({ state: 'loading' });

  const params = new URLSearchParams(location?.search ?? '');
  const next = params.get('next');
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

  if (session.state === 'loading') return null;
  if (session.state === 'signed-out') {
    if (platform === 'desktop') return <DesktopSignIn auth={auth} onSignedIn={refresh} />;
    const initialView: AuthView = location?.pathname === '/reset-password' ? 'reset' : 'sign-in';
    return <AuthScreens auth={auth} initialView={initialView} resetToken={params.get('token')} onSignedIn={refresh} />;
  }
  return (
    <Home
      platform={platform}
      apiBaseUrl={apiBaseUrl}
      status={status}
      user={session.user}
      onSignOut={async () => {
        await auth.signOut();
        refresh();
      }}
    />
  );
}
