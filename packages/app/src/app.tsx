import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAuthClient, type AuthClient, type AuthTransport } from './api/auth';
import { createCustomersClient, type CustomersClient } from './api/customers';
import { createDashboardClient, type DashboardClient } from './api/dashboard';
import { createPeopleClient, type PeopleClient } from './api/people';
import { createProjectsClient, type ProjectsClient } from './api/projects';
import { createFinanceClient, type FinanceClient } from './api/finance';
import { createReportingClient, type ReportingClient } from './api/reporting';
import { createSalesClient, type SalesClient } from './api/sales';
import { createTenancyClient, type TenancyClient } from './api/tenancy';
import { AcceptInvitation, AuthScreens, DesktopSignIn, type AuthView } from './auth/auth-screens';
import type { ClientPlatform } from './config';
import { ChooseWorkspace } from './shell/choose';
import { Frame, Startup } from './shell/frame';
import { BusinessSetup } from './shell/onboarding';
import { Failed, SessionExpiredNotice, Unreachable, Unverified } from './shell/states';
import { AppShell } from './shell/app-shell';
import { Home, type CustomerMetrics } from './shell/home';
import { OperationalDashboard, type DashboardClients } from './shell/dashboard/operational-dashboard';
import { canOpen, HOME, resolveNavigation, type ResolvedNavigation, type ShellRoute } from './shell/registry';
import { useLoad } from './zones/use-load';
import type { BusinessContext } from './api/tenancy';
import type { CurrentUser } from '@business-os/contracts';
import { CustomerZone } from './zones/customers/customer-zone';
import { PeopleZone } from './zones/people/people-zone';
import { ProjectsZone } from './zones/projects/projects-zone';
import { FinanceZone } from './zones/finance/finance-zone';
import { ReportingZone } from './zones/reporting/reporting-zone';
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
  projects?: ProjectsClient;
  people?: PeopleClient;
  finance?: FinanceClient;
  reporting?: ReportingClient;
  /** The operational dashboard's own reads (pipeline summary, business activity, upcoming events). */
  dashboard?: DashboardClient;
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
export function App({ platform, apiBaseUrl, transport, location, navigate, replaceLocation, auth: authOverride, tenancy: tenancyOverride, customers: customersOverride, sales: salesOverride, projects: projectsOverride, people: peopleOverride, finance: financeOverride, reporting: reportingOverride, dashboard: dashboardOverride, storage: storageOverride }: AppProps) {
  const resolvedTransport = useMemo<AuthTransport>(() => transport ?? { kind: 'cookie' }, [transport]);
  const auth = useMemo(() => authOverride ?? createAuthClient(apiBaseUrl, resolvedTransport), [authOverride, apiBaseUrl, resolvedTransport]);
  const tenancy = useMemo(() => tenancyOverride ?? createTenancyClient(apiBaseUrl, resolvedTransport), [tenancyOverride, apiBaseUrl, resolvedTransport]);
  const customers = useMemo(() => customersOverride ?? createCustomersClient(apiBaseUrl, resolvedTransport), [customersOverride, apiBaseUrl, resolvedTransport]);
  const sales = useMemo(() => salesOverride ?? createSalesClient(apiBaseUrl, resolvedTransport), [salesOverride, apiBaseUrl, resolvedTransport]);
  const people = useMemo(() => peopleOverride ?? createPeopleClient(apiBaseUrl, resolvedTransport), [peopleOverride, apiBaseUrl, resolvedTransport]);
  const projects = useMemo(() => projectsOverride ?? createProjectsClient(apiBaseUrl, resolvedTransport), [projectsOverride, apiBaseUrl, resolvedTransport]);
  const finance = useMemo(() => financeOverride ?? createFinanceClient(apiBaseUrl, resolvedTransport), [financeOverride, apiBaseUrl, resolvedTransport]);
  const reporting = useMemo(() => reportingOverride ?? createReportingClient(apiBaseUrl, resolvedTransport), [reportingOverride, apiBaseUrl, resolvedTransport]);
  const dashboard = useMemo(() => dashboardOverride ?? createDashboardClient(apiBaseUrl, resolvedTransport), [dashboardOverride, apiBaseUrl, resolvedTransport]);
  const dashboardClients = useMemo<DashboardClients>(() => ({ reporting, dashboard, projects, finance }), [reporting, dashboard, projects, finance]);
  const storage = useMemo(() => storageOverride ?? browserStorage(), [storageOverride]);
  const workspace = useWorkspace({ auth, tenancy, storage });
  const { phase } = workspace;
  const [mode, setMode] = useState<Mode>('default');
  /**
   * Where the person is in the shell, remembered with the business it belongs to. Leaving a business
   * (switching, signing out) always lands on Home. Kept in memory only: no URL routing yet.
   */
  const [route, setRouteState] = useState<{ slug: string | null; route: ShellRoute }>({ slug: null, route: HOME });
  const activeSlug = 'context' in phase ? phase.context.business.slug : null;
  const setRoute = (next: ShellRoute) => setRouteState({ slug: activeSlug, route: next });
  const open = (next: ShellRoute) => setRoute(next);

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

  // Private beta: "create a business" is offered only with the explicit platform grant, read from the
  // server for the signed-in user. Unknown, failed or denied all mean "not offered"; the server
  // enforces the rule regardless of what the client shows.
  const userId = user?.id ?? null;
  const [access, setAccess] = useState<{ userId: string; canCreate: boolean } | null>(null);
  const accessUser = userId && (phase.kind === 'no-workspace' || phase.kind === 'pick' || phase.kind === 'ready') ? userId : null;
  useEffect(() => {
    if (!accessUser) return;
    const controller = new AbortController();
    void tenancy.platformAccess(controller.signal).then((result) => {
      if (!controller.signal.aborted) setAccess({ userId: accessUser, canCreate: result.kind === 'ok' && result.data.canCreateBusiness === true });
    });
    return () => controller.abort();
  }, [accessUser, tenancy]);
  const accessKnown = access !== null && access.userId === userId;
  const canCreate = accessKnown && access.canCreate;
  useEffect(() => {
    if (user && next && SAFE_NEXT.test(next) && navigate) navigate(next);
  }, [user, next, navigate]);

  const signOut = () => {
    setMode('default');
    setRoute(HOME);
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

  if (phase.kind === 'invite-required') return (
    <Frame title="Invitation required" subtitle="Pixa OS is in private beta. Open your invitation email and follow its link to join.">
      <button type="button" onClick={signOut}>Sign out</button>
    </Frame>
  );

  if (phase.kind === 'unverified') return <Unverified user={phase.user} onSignOut={signOut} onRefresh={workspace.retry} />;

  const create = async (data: Parameters<typeof workspace.create>[0]) => {
    const result = await workspace.create(data);
    if (result.ok) setMode('default');
    return result;
  };
  if (phase.kind === 'no-workspace') {
    if (!accessKnown) return <Startup label="Checking your access" />;
    if (!canCreate) return (
      <Frame title="No workspace yet" subtitle="You are not a member of any business. Ask a business owner to invite you, then open the invitation link.">
        <button type="button" onClick={signOut}>Sign out</button>
      </Frame>
    );
    return <BusinessSetup onCreate={create} />;
  }
  if (mode === 'new' && canCreate) return <BusinessSetup onCreate={create} onBack={() => setMode('default')} />;

  const businesses = phase.businesses;
  if (phase.kind === 'pick' || mode === 'choose') {
    return (
      <ChooseWorkspace
        businesses={businesses}
        onSelect={(slug) => {
          setMode('default');
          workspace.select(slug);
        }}
        onCreate={canCreate ? () => setMode('new') : undefined}
        onSignOut={signOut}
        onBack={phase.kind === 'ready' ? () => setMode('default') : undefined}
        revoked={phase.kind === 'pick' ? phase.notice?.business : undefined}
      />
    );
  }
  const leaveToChooser = () => {
    setRoute(HOME);
    setMode('choose');
  };
  const active = phase.kind === 'switching' ? null : phase.context;
  const permissions = phase.context.membership.permissions;
  const navigation = resolveNavigation(phase.kind === 'switching' ? { state: 'loading' } : { state: 'ready', permissions });
  // A route is only ever honoured for a Zone the server's permissions open, and only in the business
  // it was chosen in: a switch, or a role change on refresh, lands on Home.
  const current = route.slug === phase.context.business.slug && canOpen(route.route, navigation) ? route.route : HOME;
  const canReadProjects = navigation.available.some((z) => z.id === 'projects');
  const canReadCustomers = navigation.available.some((z) => z.id === 'customers');
  const canReadFinance = navigation.available.some((z) => z.id === 'finance');
  const userLabel = phase.user.name || phase.user.email;
  const target = current.zone === 'home' ? undefined : current.target;
  const intent = current.zone === 'home' ? undefined : current.intent;
  const slug = phase.context.business.slug;

  let screen: ReactNode = null;
  if (active && current.zone === 'customers') {
    screen = (
      <CustomerZone
        key={`${slug}|${target ?? ''}|${intent ?? ''}`}
        client={customers} context={active} userLabel={userLabel} initialCustomerId={target} initialAction={intent}
        projects={canReadProjects ? { client: projects, onOpen: (id) => open({ zone: 'projects', target: id }) } : undefined}
        finance={canReadFinance ? { client: finance, onOpen: (target) => open({ zone: 'finance', child: target.startsWith('quote:') ? 'quotes' : target.startsWith('payment:') ? 'payments' : target.startsWith('statement:') ? 'receivables' : 'invoices', target }) } : undefined}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
      />
    );
  } else if (active && current.zone === 'sales') {
    screen = (
      <SalesZone
        key={`${slug}|${intent ?? ''}`}
        sales={sales} customers={customers} context={active} userLabel={userLabel} initialAction={intent}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
      />
    );
  } else if (active && current.zone === 'projects') {
    screen = (
      <ProjectsZone
        key={`${slug}|${target ?? ''}|${intent ?? ''}`}
        client={projects} customers={customers} context={active} userLabel={userLabel} initialProjectId={target} initialAction={intent}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
        onOpenCustomer={canReadCustomers ? (id) => open({ zone: 'customers', target: id }) : undefined}
      />
    );
  } else if (active && current.zone === 'people') {
    screen = (
      <PeopleZone
        key={`${slug}|${target ?? ''}|${intent ?? ''}`}
        client={people} customers={customers} context={active} userLabel={userLabel} initialEmployeeId={target} initialAction={intent}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
      />
    );
  } else if (active && current.zone === 'finance') {
    screen = (
      <FinanceZone
        key={`${slug}|${target ?? ''}|${intent ?? ''}`}
        client={finance} customers={canReadCustomers ? customers : undefined} context={active} userLabel={userLabel}
        section={current.child} navigation={current} initialTarget={target} initialAction={intent}
        // Inside the Zone, moving between sections keeps the target and intent the Zone was opened with,
        // so the shell's highlight follows without remounting the Zone (and losing its screen).
        onSection={(child) => setRoute({ ...current, child })}
        onOpenCustomer={canReadCustomers ? (id) => open({ zone: 'customers', target: id }) : undefined}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
      />
    );
  } else if (active && current.zone === 'reporting') {
    screen = (
      <ReportingZone
        key={slug}
        client={reporting} context={active} userLabel={userLabel}
        // Moving between Dashboard, Explore and Saved reports keeps the Zone mounted, so its settings survive.
        section={current.child} onSection={(child) => setRoute({ ...current, child })}
        onHome={() => open(HOME)} onSwitch={leaveToChooser} onSignOut={signOut} onSessionEnded={workspace.retry}
      />
    );
  } else if (active) {
    screen = <HomeWithMetrics key={slug} customers={customers} dashboard={dashboardClients} context={active} user={phase.user} navigation={navigation} onOpen={open} onSessionEnded={workspace.retry} />;
  }

  return (
    <AppShell
      business={{ slug, name: phase.context.business.name, role: phase.context.membership.role }}
      businesses={phase.businesses}
      user={phase.user}
      navigation={navigation}
      route={current}
      switching={phase.kind === 'switching' ? phase.to : null}
      notice={phase.kind === 'ready' ? phase.notice ?? null : null}
      onDismissNotice={workspace.dismissNotice}
      onNavigate={open}
      onSelectBusiness={(next) => {
        setRoute(HOME);
        workspace.switchTo(next);
      }}
      onChooseBusiness={leaveToChooser}
      onCreateBusiness={canCreate ? () => {
        setRoute(HOME);
        setMode('new');
      } : undefined}
      onSignOut={signOut}
    >
      {screen}
    </AppShell>
  );
}

/**
 * Home with live figures: the Customers counts (one request, shared by the Zone card and the dashboard)
 * and the operational dashboard. Mounted per business (key) and each time the person comes back from a
 * Zone, so figures reflect any changes just made.
 */
function HomeWithMetrics({ customers, dashboard, context, user, navigation, onOpen, onSessionEnded }: {
  customers: CustomersClient; dashboard: DashboardClients; context: BusinessContext; user: CurrentUser; navigation: ResolvedNavigation; onOpen: (route: ShellRoute) => void; onSessionEnded: () => void;
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
    <Home business={context.business.name} timeZone={context.business.timeZone} role={context.membership.role} user={user}
      permissions={context.membership.permissions} navigation={navigation} customerMetrics={metrics} onOpen={onOpen}
      dashboard={<OperationalDashboard context={context} clients={dashboard} customers={metrics} onOpen={onOpen} onSessionEnded={onSessionEnded} />} />
  );
}
