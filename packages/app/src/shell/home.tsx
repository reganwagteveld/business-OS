import type { CurrentUser } from '@business-os/contracts';
import { Button, Card, cn, EmptyState, SectionHeader } from '@business-os/ui';
import { Icon } from './icons';
import type { ResolvedNavigation, ShellRoute } from './registry';
import { ZonePage } from './zone-page';

/** Real counts for the Customers card, from the tenant-scoped summary endpoint. */
export type CustomerMetrics = { state: 'loading' } | { state: 'ready'; customers: number; contacts: number } | { state: 'unavailable' };

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Morning, afternoon or evening in the business's own time zone (falls back to the device's). */
export function greeting(timeZone: string | undefined, now: Date = new Date()): string {
  let hour = now.getHours();
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  } catch {
    /* unknown time zone: keep the device's hour */
  }
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function Metrics({ id, metrics }: { id: string; metrics: CustomerMetrics }) {
  if (metrics.state === 'loading') {
    return <p id={id} className="mt-4 text-xs text-muted-foreground" aria-busy="true"><span className="inline-block h-3 w-28 animate-pulse rounded bg-muted align-middle motion-reduce:animate-none" aria-hidden="true" /><span className="sr-only">Loading customer counts</span></p>;
  }
  if (metrics.state === 'unavailable') return <p id={id} className="mt-4 text-xs text-muted-foreground">Counts unavailable right now</p>;
  if (metrics.customers === 0 && metrics.contacts === 0) return <p id={id} className="mt-4 text-xs text-muted-foreground">No customers yet</p>;
  return (
    <p id={id} className="mt-4 text-xs font-medium">
      {plural(metrics.customers, 'active customer', 'active customers')} <span aria-hidden="true" className="text-muted-foreground">·</span> {plural(metrics.contacts, 'contact', 'contacts')}
    </p>
  );
}

/**
 * Home inside the shell: greeting and business, the Zones this person can open, common actions
 * their permissions allow, real summary figures where an API provides them, and a recent-activity
 * area. Nothing here is invented: Zones not built yet are labelled "coming soon", and there is no
 * cross-Zone activity feed yet, so that area says so instead of showing sample events.
 */
export function Home({ business, timeZone, role, user, permissions, navigation, customerMetrics, onOpen }: {
  business: string;
  timeZone?: string;
  role: string;
  user: CurrentUser;
  permissions: readonly string[];
  navigation: ResolvedNavigation;
  /** Omitted when the person cannot read customers: the card then shows no numbers. */
  customerMetrics?: CustomerMetrics;
  onOpen: (route: ShellRoute) => void;
}) {
  const open = new Set(navigation.available.map((z) => z.id));
  const can = (p: string) => permissions.includes(p);
  const actions = [
    open.has('customers') && can('customers:write') ? { label: 'Add customer', route: { zone: 'customers', intent: 'new' } as const } : null,
    open.has('sales') && can('sales:write') ? { label: 'Add opportunity', route: { zone: 'sales', intent: 'new' } as const } : null,
    open.has('projects') && can('projects:create') ? { label: 'New project', route: { zone: 'projects', intent: 'new' } as const } : null,
  ].filter((a) => a !== null);
  const first = (user.name ?? '').trim().split(/\s+/)[0];

  return (
    <ZonePage
      eyebrow={`${greeting(timeZone)}${first ? `, ${first}` : ''} · ${role.toLowerCase()}`}
      title={`Welcome to ${business}.`}
      description="One platform. One interface. One source of truth."
      primaryActions={actions.length ? actions.map((a, i) => (
        <Button key={a.label} variant={i === 0 ? 'primary' : 'secondary'} onClick={() => onOpen(a.route)}>
          <Icon name="plus" className="size-4" />{a.label}
        </Button>
      )) : undefined}
    >
      <section aria-labelledby="home-zones" className="space-y-4">
        <SectionHeader id="home-zones" title="Your Zones" description={open.size ? 'Open a Zone to get to work. Zones marked coming soon are on the way.' : 'No Zones are open to your role in this business yet.'} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {navigation.available.map((zone) => (
            <button key={zone.id} type="button" onClick={() => onOpen({ zone: zone.id })} aria-label={`Open the ${zone.name} Zone`}
              aria-describedby={zone.id === 'customers' && customerMetrics ? 'customer-metrics' : undefined}
              className="group flex min-h-44 flex-col items-start justify-start rounded-2xl border bg-card p-6 text-left shadow-card transition-colors hover:border-ring motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Icon name={zone.icon} /></div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{zone.name}</h3>
                <span className="rounded-md bg-primary/15 px-2 py-0.5 text-[10px] font-semibold">Open</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{zone.description}</p>
              {zone.id === 'customers' && customerMetrics ? <Metrics id="customer-metrics" metrics={customerMetrics} /> : null}
            </button>
          ))}
          {navigation.planned.map((zone) => (
            <section key={zone.id} aria-label={`${zone.name} Zone — coming soon`} className="min-h-44 rounded-2xl border border-dashed bg-card/60 p-6">
              <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon name={zone.icon} /></div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{zone.name}</h3>
                <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Coming soon</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{zone.description}</p>
            </section>
          ))}
        </div>
      </section>
      <section aria-labelledby="home-activity" className="space-y-4">
        <SectionHeader id="home-activity" title="Recent activity" />
        <Card className={cn('p-0')}>
          <EmptyState className="border-0" icon={<Icon name="activity" />} title="No combined activity feed yet"
            description="Activity across all your Zones will appear here in a later release. Each customer's own activity is on their page." />
        </Card>
      </section>
    </ZonePage>
  );
}
