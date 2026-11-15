import type { IconName } from './icons';

/**
 * The Zone navigation registry: one typed entry per Zone, read by the sidebar, the mobile drawer,
 * the breadcrumbs and the Home launcher. Adding a Zone means adding an entry here (and its screen in
 * `app.tsx`); no navigation component changes.
 *
 * The registry only DESCRIBES Zones. Whether a person may use one is decided by the API: the
 * permission keys below are the ones the server returns in `membership.permissions` for the active
 * business (apps/api/src/modules/access/server/permissions.ts). A Zone is never shown as available
 * because its entry exists, and the API still checks every request.
 */

export type ZoneId = 'customers' | 'sales' | 'projects' | 'finance' | 'people' | 'operations' | 'reporting' | 'settings';

export interface ZoneChild {
  /** Stable within its Zone. */
  id: string;
  label: string;
  route: `/${string}`;
}

export interface ZoneDefinition {
  /** Stable identifier: used for state, tests and future URLs. Never shown. */
  id: ZoneId;
  name: string;
  description: string;
  icon: IconName;
  route: `/${string}`;
  /** Lower comes first. */
  order: number;
  /** Secondary navigation inside the Zone, shown under the top bar while the Zone is open. */
  children?: readonly ZoneChild[];
  /**
   * Existing API permission keys, ALL of which the membership must hold. Never invented here and
   * never inferred from the Zone's name. Empty only for planned Zones, which cannot be opened anyway.
   */
  requires: readonly string[];
  /**
   * Whether this client has the Zone at all. `built`: it can be opened (subject to `requires`).
   * `planned`: not built yet, shown on Home as "coming soon" and never openable. There is no
   * server-side module-availability contract yet; when one exists it narrows `built` Zones further.
   */
  availability: 'built' | 'planned';
  /** Optional short status shown next to the name (for example "Beta"). Never a fabricated count. */
  status?: { label: string; tone: 'info' | 'warning' | 'neutral' };
}

export const ZONES: readonly ZoneDefinition[] = [
  { id: 'customers', name: 'Customers', description: 'Every relationship in one place', icon: 'customers', route: '/customers', order: 10, requires: ['customers:read'], availability: 'built' },
  { id: 'sales', name: 'Sales', description: 'From first contact to closed deal', icon: 'sales', route: '/sales', order: 20, requires: ['sales:read'], availability: 'built' },
  { id: 'projects', name: 'Projects', description: 'Work, organised and connected', icon: 'projects', route: '/projects', order: 30, requires: ['projects:read'], availability: 'built' },
  // F4: the whole Finance Zone. Every section is readable with finance:read; write actions inside each check their own keys.
  {
    id: 'finance', name: 'Finance', description: 'Understand your business finances', icon: 'finance', route: '/finance', order: 40, requires: ['finance:read'], availability: 'built',
    children: [
      { id: 'overview', label: 'Overview', route: '/finance' },
      { id: 'quotes', label: 'Quotes', route: '/finance/quotes' },
      { id: 'invoices', label: 'Invoices', route: '/finance/invoices' },
      { id: 'credit-notes', label: 'Credit notes', route: '/finance/credit-notes' },
      { id: 'payments', label: 'Payments', route: '/finance/payments' },
      { id: 'receivables', label: 'Receivables', route: '/finance/receivables' },
      { id: 'expenses', label: 'Expenses', route: '/finance/expenses' },
      { id: 'settings', label: 'Settings', route: '/finance/settings' },
    ],
  },
  { id: 'people', name: 'People', description: 'Your team and their work', icon: 'people', route: '/people', order: 50, requires: [], availability: 'planned' },
  { id: 'operations', name: 'Operations', description: 'Keep everything moving', icon: 'operations', route: '/operations', order: 60, requires: [], availability: 'planned' },
  // Reporting R1 (docs/reporting-r1.md): takes the place of the planned "Insights" entry. reporting:read opens the
  // Zone; every figure inside also needs its source Zone's key, which the API checks on each request.
  { id: 'reporting', name: 'Reporting', description: 'See what matters', icon: 'insights', route: '/reporting', order: 70, requires: ['reporting:read'], availability: 'built' },
  { id: 'settings', name: 'Settings', description: 'Workspace preferences', icon: 'settings', route: '/settings', order: 80, requires: [], availability: 'planned' },
];

/** Where the person is inside the shell. `target` opens one record; `intent` opens a create form. */
export type ShellRoute = { zone: 'home' } | { zone: ZoneId; child?: string; target?: string; intent?: 'new' };

export const HOME: ShellRoute = { zone: 'home' };

/**
 * What the shell knows about the active business's access. Permissions arrive with the business
 * context; while a business is being opened they are `loading`, and if that fails, `failed`.
 */
export type Discovery = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; permissions: readonly string[] };

export interface ResolvedZone extends ZoneDefinition {
  access: 'available' | 'planned';
}

export interface ResolvedNavigation {
  state: Discovery['state'];
  /** Zones the person can open, in order. Empty unless discovery is `ready`. */
  available: ResolvedZone[];
  /** Zones not built yet. Shown only as "coming soon", and only once discovery is `ready`. */
  planned: ResolvedZone[];
}

/**
 * Filters the registry by the server's permissions. Zones the person may not use are left out
 * entirely (not shown disabled), so the navigation reveals nothing about what exists for others.
 * While loading or after a failure nothing is listed: the shell shows that state instead.
 */
export function resolveNavigation(discovery: Discovery, zones: readonly ZoneDefinition[] = ZONES): ResolvedNavigation {
  if (discovery.state !== 'ready') return { state: discovery.state, available: [], planned: [] };
  const held = new Set(discovery.permissions);
  const sorted = [...zones].sort((a, b) => a.order - b.order);
  return {
    state: 'ready',
    available: sorted
      .filter((z) => z.availability === 'built' && z.requires.length > 0 && z.requires.every((p) => held.has(p)))
      .map((z) => ({ ...z, access: 'available' as const })),
    planned: sorted.filter((z) => z.availability === 'planned').map((z) => ({ ...z, access: 'planned' as const })),
  };
}

/** True when the route points at a Zone the person can open (used to refuse stale or forged routes). */
export function canOpen(route: ShellRoute, nav: ResolvedNavigation): boolean {
  return route.zone === 'home' || nav.available.some((z) => z.id === route.zone);
}
