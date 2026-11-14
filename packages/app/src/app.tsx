import { useEffect, useMemo, useState } from 'react';
import { createAuthClient, type AuthClient, type AuthTransport } from './api/auth';
import { createCustomersClient, type CustomersClient } from './api/customers';
import { createSalesClient, type SalesClient } from './api/sales';
import { createTenancyClient, type TenancyClient } from './api/tenancy';
import { AcceptInvitation, AuthScreens, DesktopSignIn, type AuthView } from './auth/auth-screens';
import type { ClientPlatform } from './config';
import { ChooseWorkspace } from './shell/choose';
import { Startup } from './shell/frame';
import { BusinessSetup } from './shell/onboarding';
import { Failed, SessionExpiredNotice, Unreachable, Unverified } from './shell/states';
import { ZoneHome, type CustomerMetrics } from './shell/zone-home';
import { useLoad } from './zones/use-load';
import type { BusinessContext } from './api/tenancy';
import type { CurrentUser } from '@business-os/contracts';
import { CustomerZone } from './zones/customers/customer-zone';
import { SalesZone } from './zones/sales/sales-zone';
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
  customers?: CustomersClient;
  sales?: SalesClient;
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
export function App({ platform, apiBaseUrl, transport, location, navigate, replaceLocation, auth: authOverride, tenancy: tenancyOverride, customers: customersOverride, sales: salesOverride, storage: storageOverride }: AppProps) {
  const resolvedTransport = useMemo<AuthTransport>(() => transport ?? { kind: 'cookie' }, [transport]);
  const auth = useMemo(() => authOverride ?? createAuthClient(apiBaseUrl, resolvedTransport), [authOverride, apiBaseUrl, resolvedTransport]);
  const tenancy = useMemo(() => tenancyOverride ?? createTenancyClient(apiBaseUrl, resolvedTransport), [tenancyOverride, apiBaseUrl, resolvedTransport]);
  const customers = useMemo(() => customersOverride ?? createCustomersClient(apiBaseUrl, resolvedTransport), [customersOverride, apiBaseUrl, resolvedTransport]);
  const sales = useMemo(() => salesOverride ?? createSalesClient(apiBaseUrl, resolvedTransport), [salesOverride, apiBaseUrl, resolvedTransport]);
  const storage = useMemo(() => storageOverride ?? browserStorage(), [storageOverride]);
  const workspace = useWorkspace({ auth, tenancy, storage });
  const { phase } = workspace;
  const [mode, setMode] = useState<Mode>('default');
  /** Which Zone is open. Leaving a Zone (switching business, signing out) always returns to the home. */
  const [zone, setZone] = useState<'home' | 'customers' | 'sales'>('home');

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
    setZone('home');
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
  const switchBusiness = () => {
    setZone('home');
    setMode('choose');
  };
  if (zone === 'customers') {
    return (
      <CustomerZone
        key={phase.context.business.slug}
        client={customers}
        context={phase.context}
        userLabel={phase.user.name || phase.user.email}
        onHome={() => setZone('home')}
        onSwitch={switchBusiness}
        onSignOut={signOut}
        onSessionEnded={workspace.retry}
      />
    );
  }
  if (zone === 'sales') {
    return (
      <SalesZone
        key={phase.context.business.slug}
        sales={sales}
        customers={customers}
        context={phase.context}
        userLabel={phase.user.name || phase.user.email}
        onHome={() => setZone('home')}
        onSwitch={switchBusiness}
        onSignOut={signOut}
        onSessionEnded={workspace.retry}
      />
    );
  }
  return (
    <HomeWithMetrics
      key={phase.context.business.slug}
      customers={customers} context={phase.context} user={phase.user}
      onSwitch={switchBusiness} onSignOut={signOut} onOpenCustomers={() => setZone('customers')}
      onOpenSales={phase.context.membership.permissions.includes('sales:read') ? () => setZone('sales') : undefined} onSessionEnded={workspace.retry}
    />
  );
}

/**
 * The Zone home with live Customers counts. Mounted per business (key) and each time the person comes
 * back from a Zone, so counts reflect any changes just made, with exactly one request per visit.
 */
function HomeWithMetrics({ customers, context, user, onSwitch, onSignOut, onOpenCustomers, onOpenSales, onSessionEnded }: {
  customers: CustomersClient; context: BusinessContext; user: CurrentUser;
  onSwitch: () => void; onSignOut: () => void; onOpenCustomers: () => void; onOpenSales?: () => void; onSessionEnded: () => void;
}) {
  const slug = context.business.slug;
  const canRead = context.membership.permissions.includes('customers:read');
  const summary = useLoad(`home-summary|${slug}|${canRead}`, (signal) =>
    canRead ? customers.summary(slug, signal) : Promise.resolve({ kind: 'forbidden' as const }));
  const ended = summary.state.status === 'done' && summary.state.outcome.kind === 'unauthenticated';
  useEffect(() => {
    if (ended) onSessionEnded();
  }, [ended, onSessionEnded]);
  let metrics: CustomerMetrics | undefined;
  if (canRead) {
    metrics = summary.state.status === 'loading' ? { state: 'loading' }
      : summary.state.outcome.kind === 'ok' ? { state: 'ready', customers: summary.state.outcome.data.customers.active, contacts: summary.state.outcome.data.contacts.active }
      : { state: 'unavailable' };
  }
  return (
    <ZoneHome business={context.business.name} user={user} role={context.membership.role} onSwitch={onSwitch} onSignOut={onSignOut}
      onOpenCustomers={onOpenCustomers} onOpenSales={onOpenSales} customerMetrics={metrics} />
  );
}
