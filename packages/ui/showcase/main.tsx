import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, AlertDescription, AlertTitle, Atmosphere, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger, EmptyState, Field, FormSection, Input,
  PageHeader, SectionHeader, Select, Separator, Skeleton, Spinner, StatCard, StatusIndicator, Surface, Table, TableBody, TableCaption,
  TableCell, TableHead, TableHeader, TableRow, Textarea, cn, type AtmosphereVariant,
} from '../src';
import './showcase.css';

type Theme = 'system' | 'light' | 'dark';

// The same mechanism the apps use: no class follows the OS, `.light` / `.dark` on <html> overrides it.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  if (theme !== 'system') root.classList.add(theme);
}

const initialTheme = (new URLSearchParams(location.search).get('theme') as Theme | null) ?? 'system';

const PALETTE = [
  ['Midnight foundation', '--pk-midnight'],
  ['Deep navy', '--pk-navy'],
  ['Electric indigo', '--pk-indigo'],
  ['Electric blue', '--pk-electric'],
  ['Soft violet', '--pk-violet'],
  ['Lavender', '--pk-lavender'],
  ['Dusty pink', '--pk-pink'],
  ['Mist', '--pk-mist'],
] as const;

const SEMANTIC: Array<[string, string[]]> = [
  ['Canvas and surfaces', ['--bg-canvas', '--bg-sunken', '--bg-surface', '--bg-raised']],
  ['States', ['--bg-hover', '--bg-selected', '--disabled-bg', '--focus-ring']],
  ['Text', ['--fg-default', '--fg-muted', '--fg-subtle', '--fg-accent']],
  ['Accent', ['--accent-solid', '--accent-hover', '--accent-subtle']],
  ['Lines and fields', ['--border-default', '--border-strong', '--border-input', '--field']],
  ['Status (text)', ['--status-success-fg', '--status-warning-fg', '--status-danger-fg', '--status-info-fg']],
];

const TYPE_SCALE = [
  ['display', 'text-display font-semibold', '28 / 36 · Home only'],
  ['title', 'text-title font-semibold', '22 / 28 · page title'],
  ['section', 'text-section font-semibold', '18 / 24 · section title'],
  ['lead', 'text-lead', '16 / 24 · lead'],
  ['body', 'text-body', '14 / 20 · body (default)'],
  ['small', 'text-small', '13 / 18 · small and tables'],
  ['caption', 'text-caption text-fg-subtle', '12 / 16 · caption'],
] as const;

const STATUS_TONES = ['success', 'warning', 'danger', 'info'] as const;
const STATUS_CLASS: Record<(typeof STATUS_TONES)[number], string> = {
  success: 'border-status-success-border bg-status-success-bg text-status-success-fg',
  warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-fg',
  danger: 'border-status-danger-border bg-status-danger-bg text-status-danger-fg',
  info: 'border-status-info-border bg-status-info-bg text-status-info-fg',
};

const ROWS = [
  { ref: 'INV-1042', customer: 'Harbour & Pine Ltd', zone: 'Finance', owner: 'R. Wagteveld', amount: '£4,820.00', status: ['success', 'Paid'] },
  { ref: 'OPP-0381', customer: 'Northlight Studio', zone: 'Sales', owner: 'A. Okafor', amount: '£12,400.00', status: ['info', 'Proposal'] },
  { ref: 'PRJ-0217', customer: 'Kestrel Logistics', zone: 'Projects', owner: 'M. Laurent', amount: '£7,150.00', status: ['warning', 'At risk'] },
  { ref: 'INV-1039', customer: 'Bramble Foods', zone: 'Finance', owner: 'R. Wagteveld', amount: '£960.00', status: ['danger', 'Overdue'] },
  { ref: 'CUS-0904', customer: 'Odessa Health', zone: 'Customers', owner: 'J. Park', amount: '—', status: ['neutral', 'Draft'] },
] as const;

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-5 py-10">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Swatch({ label, token }: { label: string; token: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="size-10 shrink-0 rounded-lg border" style={{ background: `var(${token})` }} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <code className="block truncate text-xs text-muted-foreground">{token}</code>
      </span>
    </div>
  );
}

function Controls() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button>Create invoice</Button>
        <Button variant="secondary">Export</Button>
        <Button variant="outline">Filter</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="destructive">Delete</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Saving</Button>
        <Button size="sm" variant="secondary">Small</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge>Neutral</Badge>
        <Badge tone="brand">Pixakova</Badge>
        <Badge tone="success">Paid</Badge>
        <Badge tone="warning">At risk</Badge>
        <Badge tone="danger">Overdue</Badge>
        <Badge tone="info">Proposal</Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <StatusIndicator tone="ok">API reachable</StatusIndicator>
        <StatusIndicator tone="pending">Syncing</StatusIndicator>
        <StatusIndicator tone="error">Not reachable</StatusIndicator>
        <StatusIndicator tone="info">Update available</StatusIndicator>
        <Spinner label="Loading customers" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer name" hint="As it appears on invoices">{(p) => <Input {...p} placeholder="Harbour & Pine Ltd" />}</Field>
        <Field label="VAT number" error="Enter a valid VAT number">{(p) => <Input {...p} defaultValue="GB12" />}</Field>
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

function OperationsTable() {
  return (
    <Table>
      <TableCaption>Recent activity across Zones. Rows highlight on hover; the second row is selected.</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Reference</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Zone</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROWS.map((row, i) => (
          <TableRow key={row.ref} aria-selected={i === 1 || undefined}>
            <TableCell className="font-mono text-xs">{row.ref}</TableCell>
            <TableCell className="font-medium">{row.customer}</TableCell>
            <TableCell className="text-muted-foreground">{row.zone}</TableCell>
            <TableCell className="text-muted-foreground">{row.owner}</TableCell>
            <TableCell className="text-right tabular-nums">{row.amount}</TableCell>
            <TableCell><Badge tone={row.status[0]}>{row.status[1]}</Badge></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function OperationsForm() {
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <FormSection title="Invoice details" description="Grouped as a fieldset, so the section name is announced with each field." className="[&>div]:sm:grid-cols-2">
      <Field label="Customer">{(p) => <Select {...p} defaultValue="hp"><option value="hp">Harbour &amp; Pine Ltd</option><option value="nl">Northlight Studio</option></Select>}</Field>
      <Field label="Due date">{(p) => <Input {...p} type="date" defaultValue="2026-12-01" />}</Field>
      <Field label="Amount (GBP)" hint="Excluding VAT">{(p) => <Input {...p} inputMode="decimal" defaultValue="4,820.00" />}</Field>
      <Field label="Purchase order">{(p) => <Input {...p} placeholder="Optional" />}</Field>
      <Field label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} placeholder="Shown on the invoice" />}</Field>
      </FormSection>
      <Separator className="my-6" />
      <div className="flex justify-end gap-3">
        <Button variant="ghost">Cancel</Button>
        <Button type="submit">Save invoice</Button>
      </div>
    </form>
  );
}

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger asChild><Button variant="outline">Open dialog</Button></DialogTrigger>
      <DialogContent>
        <DialogTitle>Archive this customer?</DialogTitle>
        <DialogDescription>Harbour &amp; Pine Ltd will be hidden from lists. Invoices and projects stay as they are, and you can restore the customer at any time.</DialogDescription>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost" autoFocus>Keep customer</Button></DialogClose>
          <DialogClose asChild><Button variant="destructive">Archive</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Foundations() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-panel border border-line bg-surface p-5">
        <h3 className="text-section font-semibold">Type scale</h3>
        <p className="mt-1 text-small text-fg-muted">Inter, bundled. Figures are tabular: 1,234.50 · 98,760.00</p>
        <div className="mt-4 grid gap-3">
          {TYPE_SCALE.map(([name, cls, note]) => (
            <div key={name} className="flex items-baseline justify-between gap-4 border-b border-line pb-2 last:border-0">
              <span className={cls}>The quick brown fox</span>
              <code className="shrink-0 text-caption text-fg-subtle">{note}</code>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-6">
        <div className="rounded-panel border border-line bg-surface p-5">
          <h3 className="text-section font-semibold">Controls and rows</h3>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {([['sm', 'h-control-sm'], ['md', 'h-control-md'], ['lg', 'h-control-lg']] as const).map(([size, height]) => (
              <span key={size} className={`${height} inline-flex items-center rounded-control border border-line-strong px-3 text-small`}>{`control ${size}`}</span>
            ))}
          </div>
          <div className="mt-4 overflow-hidden rounded-control border border-line">
            {([['compact', 'h-row-compact'], ['default', 'h-row-default'], ['comfortable', 'h-row-comfortable']] as const).map(([row, height]) => (
              <div key={row} className={`${height} flex items-center border-b border-line px-3 text-small last:border-0`}>{`row ${row}`}</div>
            ))}
          </div>
        </div>
        <div className="rounded-panel border border-line bg-surface p-5">
          <h3 className="text-section font-semibold">State recipes</h3>
          <p className="mt-1 text-small text-fg-muted">Hover, press, select and Tab through these. In forced colours selection uses Highlight.</p>
          <div className="mt-4 grid gap-1">
            <button type="button" className="state-interactive focus-ring rounded-control px-3 py-2 text-left text-small">Hover and pressed</button>
            <button type="button" aria-pressed="true" className="state-selected focus-ring rounded-control px-3 py-2 text-left text-small">Selected</button>
            <button type="button" disabled className="state-disabled rounded-control px-3 py-2 text-left text-small">Disabled</button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {STATUS_TONES.map((tone) => (
              <span key={tone} className={`inline-flex items-center gap-1.5 rounded-pill border px-2 text-caption font-medium ${STATUS_CLASS[tone]}`}>
                <span aria-hidden="true" className="size-1.5 rounded-pill bg-current" />{tone}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Showcase() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [atmosphere, setAtmosphere] = useState<AtmosphereVariant>('aurora');
  useEffect(() => applyTheme(theme), [theme]);

  return (
    <div className="min-h-screen">
      <Atmosphere variant={atmosphere} className="min-h-[560px] border-b">
        <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5">
          <div>
            <p className="text-sm font-extrabold tracking-tight">BUSINESS OS</p>
            <p className="text-[10px] tracking-[.18em] text-muted-foreground">POWERED BY PIXAKOVA · DESIGN SYSTEM</p>
          </div>
          <Surface variant="glass" strength="subtle" className="flex flex-wrap items-center gap-3 rounded-full px-3 py-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Theme
              <Select className="h-8 w-28 rounded-full text-xs" value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
                <option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">Background
              <Select className="h-8 w-28 rounded-full text-xs" value={atmosphere} onChange={(e) => setAtmosphere(e.target.value as AtmosphereVariant)}>
                <option value="aurora">Aurora</option><option value="dusk">Dusk</option><option value="horizon">Horizon</option><option value="calm">Calm</option>
              </Select>
            </label>
          </Surface>
        </header>
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-5 pt-10 pb-16 lg:grid-cols-[1.1fr_1fr]">
          <div>
            <Badge tone="brand">Pixakova identity</Badge>
            <h1 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">Welcome to Business OS</h1>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">Midnight foundations, electric indigo, soft violet light and frosted glass, shared by the desktop and browser apps through one set of semantic tokens.</p>
            <div className="mt-8 flex flex-wrap gap-3"><Button size="lg">Open workspace</Button><Button size="lg" variant="secondary">View Zones</Button></div>
          </div>
          <Card variant="glass">
            <CardHeader><CardTitle>This month</CardTitle><CardDescription>Glass card over the atmosphere</CardDescription></CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              {[['Revenue', '£48,210'], ['Open deals', '23'], ['Overdue', '£960'], ['Projects at risk', '1']].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border/60 p-3">
                  <p className="text-xs text-muted-foreground">{k}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">{v}</p>
                </div>
              ))}
            </CardContent>
            <CardFooter><StatusIndicator tone="ok">All Zones in sync</StatusIndicator></CardFooter>
          </Card>
        </div>
      </Atmosphere>

      <Section title="Foundations (V2)" description="Type scale, control and row heights, state recipes and status tones from the V2 tokens (V2-B1). Components adopt them from V2-B3 onwards.">
        <Foundations />
      </Section>

      <Section title="Colour system" description="The Pixakova palette only feeds the semantic tokens. Components use semantic tokens, never palette colours. Every V1 name (background, primary, muted-foreground …) is now an alias of a V2 token.">
        <h3 className="text-sm font-semibold text-muted-foreground">Palette</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{PALETTE.map(([l, t]) => <Swatch key={t} label={l} token={t} />)}</div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SEMANTIC.map(([group, tokens]) => (
            <Card key={group}><CardHeader><CardTitle className="text-sm">{group}</CardTitle></CardHeader><CardContent className="grid gap-3">{tokens.map((t) => <Swatch key={t} label={t.slice(2)} token={t} />)}</CardContent></Card>
          ))}
        </div>
      </Section>

      <Atmosphere variant="dusk" className="border-y">
        <Section title="Surfaces" description="Opaque and raised surfaces carry dense content. Glass is for summaries over the atmosphere; its translucency is configurable and it turns opaque when blur is unavailable or reduced transparency is on.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Surface className="p-5"><p className="font-medium">Opaque</p><p className="mt-1 text-sm text-muted-foreground">Card surface</p></Surface>
            <Surface variant="raised" className="p-5"><p className="font-medium">Raised</p><p className="mt-1 text-sm text-muted-foreground">Above a card</p></Surface>
            <Surface variant="glass" strength="subtle" className="p-5"><p className="font-medium">Glass, subtle</p><p className="mt-1 text-sm text-muted-foreground">45% tint</p></Surface>
            <Surface variant="glass" className="p-5"><p className="font-medium">Glass, regular</p><p className="mt-1 text-sm text-muted-foreground">62% tint</p></Surface>
            <Surface variant="glass" strength="strong" className="p-5"><p className="font-medium">Glass, strong</p><p className="mt-1 text-sm text-muted-foreground">86% tint, for dense content</p></Surface>
          </div>
        </Section>
      </Atmosphere>

      <Section title="Components on both surfaces" description="Controls stay flat: no gradients or glow inside them. Press Tab to see the focus ring on every control.">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>On an opaque card</CardTitle></CardHeader><CardContent><Controls /></CardContent></Card>
          <Atmosphere variant="aurora" className="rounded-2xl p-4">
            <Card variant="glass" strength="strong"><CardHeader><CardTitle>On glass</CardTitle></CardHeader><CardContent><Controls /></CardContent></Card>
          </Atmosphere>
        </div>
      </Section>

      <Section title="Page structure and feedback" description="Page and section headers, figures, empty states and alerts for every Zone.">
        <Card className="p-6">
          <PageHeader eyebrow="Finance" title="Invoices" description="Everything billed to customers this year." actions={<><Button variant="outline">Export</Button><Button>New invoice</Button></>} />
          <Separator className="my-6" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Billed this month" value="£48,210" change="+12% vs last month" trend="up" />
            <StatCard label="Outstanding" value="£9,340" change="3 invoices" />
            <StatCard label="Overdue" value="£960" change="+1 since last week" trend="down" />
            <StatCard label="Average days to pay" value="18" change="−2 days" trend="up" />
          </div>
          <SectionHeader className="mt-8" title="Drafts" description="Invoices you have not sent yet." actions={<Button size="sm" variant="ghost">View all</Button>} />
          <EmptyState className="mt-4" icon={<span className="text-lg">✦</span>} title="No drafts" description="Invoices you start but do not send appear here." action={<Button variant="secondary">Start an invoice</Button>} />
          <div className="mt-6 grid gap-3 lg:grid-cols-2">
            <Alert tone="info"><AlertTitle>Bank feed connected</AlertTitle><AlertDescription>Payments will match to invoices automatically.</AlertDescription></Alert>
            <Alert tone="success"><AlertTitle>Invoice INV-1042 sent</AlertTitle><AlertDescription>Harbour &amp; Pine Ltd will receive it by email.</AlertDescription></Alert>
            <Alert tone="warning"><AlertTitle>VAT number missing</AlertTitle><AlertDescription>Add it before sending invoices to EU customers.</AlertDescription></Alert>
            <Alert tone="danger"><AlertTitle>Payment failed</AlertTitle><AlertDescription>The card ending 4242 was declined.</AlertDescription></Alert>
          </div>
        </Card>
      </Section>

      <Atmosphere variant="calm" className="border-t">
        <Section title="Operational table and form" description="Dense work uses the calm background and opaque surfaces so text keeps full contrast.">
          <div className="grid gap-6">
            <OperationsTable />
            <Card><CardHeader><CardTitle>New invoice</CardTitle><CardDescription>Form on an opaque card</CardDescription></CardHeader><CardContent><OperationsForm /></CardContent></Card>
            <Card variant="glass" strength="strong"><CardHeader><CardTitle>Dialog</CardTitle><CardDescription>Focus moves in, Tab stays inside, Escape or either button closes it and returns focus to the opener.</CardDescription></CardHeader><CardContent><DialogDemo /></CardContent></Card>
          </div>
        </Section>
      </Atmosphere>
      <footer className={cn('px-5 py-8 text-center text-xs text-muted-foreground')}>Business OS design system · development showcase</footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Showcase /></StrictMode>);
