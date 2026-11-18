import { useEffect } from 'react';
import type { ProjectsClient } from '../../api/projects';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { LinkPicker, type LinkOption } from '../link-picker';
import { PROJECT_STATUS_LABEL } from '../projects/format';
import { STATUS_LABEL } from '../sales/format';
import { useLoad } from '../use-load';

/**
 * LC-2: the optional Opportunity and Project links of a Finance record. The Finance Zone stores only the
 * id (and, to keep the form honest, the customer the record belongs to); the Sales and Projects Zones own
 * the records. A picker is offered only with that Zone's read key, and lists only records of the chosen
 * customer, so the server's customer rule (W1 I1) is rarely hit.
 */
export interface LinkRef {
  id: string;
  /** `null` while the name is still being read. */
  label: string | null;
  /** The customer the record belongs to; `undefined` until known, `null` for a customerless opportunity. */
  customerId: string | null | undefined;
}

const SHOWN = 8;

/** Reads the name (and customer) of a linked record once, so an edit form can show it. A record that cannot be read gets a neutral label. */
function useResolvedRef(value: LinkRef | null, kind: 'opportunity' | 'project', slug: string,
  load: (id: string, signal: AbortSignal) => Promise<Outcome<{ label: string; customerId: string | null }>>, onResolved: (ref: LinkRef) => void) {
  const missing = value !== null && (value.label === null || value.customerId === undefined);
  const id = value?.id;
  const loaded = useLoad(missing ? `link-name|${kind}|${slug}|${id}` : 'link-name-idle', (signal) => (missing && id ? load(id, signal) : Promise.resolve({ kind: 'unreachable' as const })));
  const done = missing && loaded.state.status === 'done' ? loaded.state.outcome : null;
  useEffect(() => {
    if (!done || !id) return;
    if (done.kind === 'ok') onResolved({ id, label: done.data.label, customerId: done.data.customerId });
    else if (done.kind !== 'unreachable') onResolved({ id, label: `This ${kind} (not available to you)`, customerId: value?.customerId ?? null });
    // Applied once per answer: the answer is the dependency, the callback is fresh on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, id]);
}

export function OpportunityField({ sales, slug, customerId, value, onChange, onResolved, onSessionEnded, error }: {
  sales: SalesClient; slug: string; customerId: string; value: LinkRef | null; onChange: (ref: LinkRef | null) => void; onResolved: (ref: LinkRef) => void;
  onSessionEnded: () => void; error?: string;
}) {
  useResolvedRef(value, 'opportunity', slug, async (id, signal) => {
    const out = await sales.get(slug, id, signal);
    return out.kind === 'ok' ? { kind: 'ok', data: { label: out.data.title, customerId: out.data.customerId } } : out;
  }, onResolved);
  return (
    <LinkPicker
      id="doc-opportunity" label="Opportunity" noun="opportunity" plural="opportunities" hint="Optional. Open and won opportunities of this customer."
      selected={value ? { id: value.id, label: value.label } : null} searchKey={`opp|${slug}|${customerId}`}
      disabledReason={customerId ? undefined : 'Choose the customer first.'}
      search={async (q, signal) => {
        const out = await sales.list(slug, { q, status: 'all', archived: 'active', customerId, limit: 25 }, signal);
        if (out.kind !== 'ok') return out;
        const options: LinkOption[] = out.data.opportunities.filter((o) => o.status !== 'LOST').slice(0, SHOWN)
          .map((o) => ({ id: o.id, label: o.title, detail: STATUS_LABEL[o.status], customerId: o.customerId }));
        return { kind: 'ok', data: options };
      }}
      onPick={(o) => onChange(o ? { id: o.id, label: o.label, customerId: o.customerId ?? null } : null)} onSessionEnded={onSessionEnded} error={error}
    />
  );
}

export function ProjectField({ projects, slug, customerId, requireCustomer, value, onChange, onResolved, onSessionEnded, error, id = 'doc-project' }: {
  projects: ProjectsClient; slug: string; customerId: string;
  /** Documents always have a customer, so their picker waits for one. An expense may have no customer and then lists every project. */
  requireCustomer: boolean;
  value: LinkRef | null; onChange: (ref: LinkRef | null) => void; onResolved: (ref: LinkRef) => void; onSessionEnded: () => void; error?: string; id?: string;
}) {
  useResolvedRef(value, 'project', slug, async (pid, signal) => {
    const out = await projects.get(slug, pid, signal);
    return out.kind === 'ok' ? { kind: 'ok', data: { label: out.data.name, customerId: out.data.customerId } } : out;
  }, onResolved);
  return (
    <LinkPicker
      id={id} label="Project" noun="project" plural="projects"
      hint={requireCustomer ? 'Optional. Projects of this customer.' : customerId ? 'Optional. Projects of this customer.' : 'Optional. Any project of this business.'}
      selected={value ? { id: value.id, label: value.label } : null} searchKey={`proj|${slug}|${customerId}`}
      disabledReason={requireCustomer && !customerId ? 'Choose the customer first.' : undefined}
      search={async (q, signal) => {
        const out = await projects.list(slug, { q, status: 'all', archived: 'active', customerId: customerId || undefined, limit: SHOWN }, signal);
        if (out.kind !== 'ok') return out;
        return { kind: 'ok', data: out.data.projects.map((p): LinkOption => ({ id: p.id, label: p.name, detail: PROJECT_STATUS_LABEL[p.status], customerId: p.customerId })) };
      }}
      onPick={(o) => onChange(o ? { id: o.id, label: o.label, customerId: o.customerId ?? null } : null)} onSessionEnded={onSessionEnded} error={error}
    />
  );
}

/**
 * Whether a chosen link still fits a customer (W1 I1): a record of another customer is cleared before saving, so
 * the person never meets the server's 400. A customerless opportunity fits any customer; a customerless
 * project fits none (the server refuses it), and a record whose customer is not known yet is left to the server.
 */
export function fitsCustomer(ref: LinkRef | null, customerId: string, customerlessFits: boolean): boolean {
  if (ref === null || ref.customerId === undefined) return true;
  return ref.customerId === null ? customerlessFits : ref.customerId === customerId;
}

/**
 * A related record on a document's page (LC-2): the opportunity or project it is linked to, by name and state.
 * Rendered only when the person holds that Zone's read key (the caller checks), and a record that cannot be
 * read says so plainly instead of naming anything. It opens in its own Zone through `onOpen` when there is one.
 */
export function RelatedChip({ kind, slug, id, sales, projects, onOpen }: {
  kind: 'opportunity' | 'project'; slug: string; id: string; sales: SalesClient | null; projects: ProjectsClient | null; onOpen?: (id: string) => void;
}) {
  const { state } = useLoad(`related-chip|${kind}|${slug}|${id}`, async (signal): Promise<Outcome<{ name: string; status: string }>> => {
    if (kind === 'opportunity' && sales) {
      const out = await sales.get(slug, id, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: { name: out.data.title, status: STATUS_LABEL[out.data.status] } } : out;
    }
    if (kind === 'project' && projects) {
      const out = await projects.get(slug, id, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: { name: out.data.name, status: PROJECT_STATUS_LABEL[out.data.status] } } : out;
    }
    return { kind: 'forbidden' };
  });
  if (state.status === 'loading') return <span className="text-sm text-muted-foreground">Loading…</span>;
  if (state.outcome.kind !== 'ok') return <span className="text-sm text-muted-foreground">This {kind} can’t be shown.</span>;
  const { name, status } = state.outcome.data;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {onOpen ? (
        <button type="button" onClick={() => onOpen(id)} className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring [overflow-wrap:anywhere]">{name}</button>
      ) : <span className="font-medium [overflow-wrap:anywhere]">{name}</span>}
      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{status}</span>
    </span>
  );
}
