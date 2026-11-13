import type { CurrentUser } from '@business-os/contracts';

const zones = [
  { name: 'Customers', icon: '◉', description: 'Every relationship in one place', ready: false },
  { name: 'Sales', icon: '↗', description: 'From first contact to closed deal', ready: false },
  { name: 'Projects', icon: '▦', description: 'Work, organised and connected', ready: false },
  { name: 'Finance', icon: '◈', description: 'Understand your business finances', ready: false },
  { name: 'People', icon: '♧', description: 'Your team and their work', ready: false },
  { name: 'Operations', icon: '⌘', description: 'Keep everything moving', ready: false },
  { name: 'Insights', icon: '◷', description: 'See what matters', ready: false },
  { name: 'Settings', icon: '⚙', description: 'Workspace preferences', ready: false },
] as const;

export function ZoneHome({ business, user, role, onSwitch, onSignOut }: {
  business: string; user: CurrentUser; role: string; onSwitch: () => void; onSignOut: () => void;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-xl bg-foreground text-lg font-semibold text-background">B</div>
            <div>
              <p className="text-sm font-bold tracking-tight">BUSINESS OS</p>
              <p className="text-[10px] font-medium tracking-[.15em] text-muted-foreground">POWERED BY PIXAKOVA</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <button type="button" onClick={onSwitch} className="rounded-lg border border-border px-3 py-2 font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label={`Switch business, current business ${business}`}>
              {business} <span aria-hidden="true" className="ml-2 text-muted-foreground">⌄</span>
            </button>
            <span className="hidden text-muted-foreground sm:inline">{user.name || user.email}</span>
            <button type="button" onClick={onSignOut} className="rounded-lg px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">Sign out</button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-7xl px-6 pb-20 pt-12">
        <div className="mb-12">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-muted-foreground">Your workspace · {role.toLowerCase()}</p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Welcome to {business}.</h1>
          <p className="mt-4 max-w-xl text-base text-muted-foreground">One platform. One interface. One source of truth.</p>
        </div>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Your Zones</h2>
          <p className="text-xs text-muted-foreground">Your workspace is ready. Modules are coming next.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {zones.map((zone, index) => (
            <section key={zone.name} aria-label={`${zone.name} Zone — coming soon`} className="group relative min-h-52 rounded-2xl border border-border bg-card p-6 shadow-sm transition-colors hover:border-ring/50">
              <div className="mb-7 flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-2xl" aria-hidden="true">{zone.icon}</div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold">{zone.name}</h3>
                <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-medium text-muted-foreground">Coming soon</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{zone.description}</p>
              <span className="absolute right-5 top-5 text-xs text-muted-foreground/60">{String(index + 1).padStart(2, '0')}</span>
            </section>
          ))}
        </div>
        <footer className="mt-14 border-t border-border pt-6 text-xs text-muted-foreground">Business OS <span aria-hidden="true">·</span> Powered by Pixakova</footer>
      </div>
    </main>
  );
}
