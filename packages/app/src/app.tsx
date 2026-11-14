import { useEffect, useMemo, useState } from 'react';
import { createAuthClient, type AuthClient, type AuthTransport } from './api/auth';
import { createTenancyClient, type TenancyClient } from './api/tenancy';
import { AcceptInvitation, AuthScreens, DesktopSignIn, type AuthView } from './auth/auth-screens';
import type { ClientPlatform } from './config';
import { ChooseWorkspace } from './shell/choose';
import { Startup } from './shell/frame';
import { BusinessSetup } from './shell/onboarding';
import { Failed, SessionExpiredNotice, Unreachable, Unverified } from './shell/states';
import { ZoneHome } from './shell/zone-home';
import { browserStorage, type WorkspaceStorage } from './workspace/storage';
import { useWorkspace } from './workspace/use-workspace';

export interface AppProps {
  platform: ClientPlatform;
  apiBaseUrl: string;
  /** How this client authenticates: cookie (browser app) or bearer from the OS credential store (desktop). */
  transport?: AuthTransport;
  /** Browser app only: the current path and query, used for /sign-in?next=…, /reset-password?token=… and /invite?token=…. */
  location?: { pathname: string; search: string };
  /** Browser app only: full-page navigation (used to resume a desktop sign-in after signing in). */
  navigate?: (url: string) => void;
  /** Browser app only: replaces the address-bar path without reloading (drops one-time tokens from the URL). */
  replaceLocation?: (path: string) => void;
  /** Injected in tests; production uses the default fetch-based clients and localStorage. */
  auth?: AuthClient;
  tenancy?: TenancyClient;
  storage?: WorkspaceStorage;
}

// After a browser sign-in, only the desktop authorisation page may be resumed (no open redirects).
const SAFE_NEXT = /^\/api\/v1\/auth\/desktop\/authorize\?[A-Za-z0-9_\-.=&%]+$/;

/** Which screen the signed-in person asked for on top of the resolved state (switching or adding a business). */
type Mode = 'default' | 'choose' | 'new';

/**
 * The shared client application, rendered identically by apps/desktop and apps/web.
 * Boot order: ask the server who you are (never assuming), then which businesses you belong to, then
 * open the right one. Offline, server errors and an ended session each get their own screen, and
 * the active business is only ever one the server lists for you.
 */
export function App({ platform, apiBaseUrl, transport, location, navigate, replaceLocation, auth: authOverride, tenancy: tenancyOverride, storage: storageOverride }: AppProps) {
  const resolvedTransport = useMemo<AuthTransport>(() => transport ?? { kind: 'cookie' }, [transport]);
  const auth = useMemo(() => authOverride ?? createAuthClient(apiBaseUrl, resolvedTransport), [authOverride, apiBaseUrl, resolvedTransport]);
  const tenancy = useMemo(() => tenancyOverride ?? createTenancyClient(apiBaseUrl, resolvedTransport), [tenancyOverride, apiBaseUrl, resolvedTransport]);
  const storage = useMemo(() => storageOverride ?? browserStorage(), [storageOverride]);
  const workspace = useWorkspace({ auth, tenancy, storage });
  const { phase } = workspace;
  const [mode, setMode] = useState<Mode>('default');

  const params = new URLSearchParams(location?.search ?? '');
  const next = params.get('next');
  // Invitation links (/invite?token=…) open the accept screen once signed in. The token is read once
  // and removed from the address bar so it does not stay in history or get shared by accident.
  const [inviteToken] = useState(() => (location?.pathname === '/invite' ? params.get('token') : null));
  const [inviteDone, setInviteDone] = useState(location?.pathname !== '/invite');
  useEffect(() => {
    if (location?.pathname === '/invite' && replaceLocation) replaceLocation('/invite');
  }, [location?.pathname, replaceLocation]);

  const user = 'user' in phase ? phase.user : null;
  useEffect(() => {
    if (user && next && SAFE_NEXT.test(next) && navigate) navigate(next);
  }, [user, next, navigate]);

  const signOut = () => {
    setMode('default');
    void workspace.signOut();
  };

  if (phase.kind === 'booting') return <Startup label={phase.message} />;
  if (phase.kind === 'unreachable') return <Unreachable offline={typeof navigator !== 'undefined' && navigator.onLine === false} onRetry={workspace.retry} />;
  if (phase.kind === 'failed') return <Failed onRetry={workspace.retry} onSignOut={signOut} />;

  if (phase.kind === 'signed-out') {
    if (platform === 'desktop') {
      return (
        <>
          {phase.expired ? <SessionExpiredNotice /> : null}
          <DesktopSignIn auth={auth} onSignedIn={workspace.retry} />
        </>
      );
    }
    const initialView: AuthView = location?.pathname === '/reset-password' ? 'reset' : inviteToken ? 'sign-up' : 'sign-in';
    return (
      <>
        {phase.expired ? <SessionExpiredNotice /> : null}
        <AuthScreens auth={auth} initialView={initialView} resetToken={params.get('token')} onSignedIn={workspace.retry} />
      </>
    );
  }

  if (!inviteDone) {
    return (
      <AcceptInvitation
        auth={auth}
        token={inviteToken}
        email={phase.user.email}
        onDone={() => {
          setInviteDone(true);
          replaceLocation?.('/');
          workspace.retry(); // membership may have changed
        }}
      />
    );
  }

  if (phase.kind === 'unverified') return <Unverified user={phase.user} onSignOut={signOut} onRefresh={workspace.retry} />;

  const create = async (data: Parameters<typeof workspace.create>[0]) => {
    const result = await workspace.create(data);
    if (result.ok) setMode('default');
    return result;
  };
  if (phase.kind === 'no-workspace') return <BusinessSetup onCreate={create} />;
  if (mode === 'new') return <BusinessSetup onCreate={create} onBack={() => setMode('default')} />;

  const businesses = phase.businesses;
  if (phase.kind === 'pick' || mode === 'choose') {
    return (
      <ChooseWorkspace
        businesses={businesses}
        onSelect={(slug) => {
          setMode('default');
          workspace.select(slug);
        }}
        onCreate={() => setMode('new')}
        onSignOut={signOut}
      />
    );
  }
  return <ZoneHome business={phase.context.business.name} user={phase.user} role={phase.context.membership.role} onSwitch={() => setMode('choose')} onSignOut={signOut} />;
}
