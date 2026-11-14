import type { Opportunity } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { SalesClient } from '../../api/sales';
import type { BusinessContext, Outcome } from '../../api/tenancy';
import { useDraftGuard } from '../drafts';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { OpportunityDetail } from './opportunity-detail';
import { OpportunityForm } from './opportunity-form';
import { OpportunityList, type ListQuery } from './opportunity-list';
import type { Names, SalesRef } from './types';

export type { Names, SalesRef } from './types';

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; opportunity: Opportunity };

/**
 * The Sales Zone: opportunities list, create/edit form and opportunity workspace. Mount it with
 * `key={slug}` so switching business discards every bit of this state (records, names, filters);
 * nothing is persisted or cached outside the component.
 */
export function SalesZone({ sales, customers, context, userLabel, onHome, onSwitch, onSignOut, onSessionEnded }: {
  sales: SalesClient; customers: CustomersClient; context: BusinessContext; userLabel: string;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, timeZone, locale, currency } = context.business;
  const canWrite = context.membership.permissions.includes('sales:write');
  const [view, setView] = useState<View>({ name: 'list' });
  const [query, setQuery] = useState<ListQuery>({ q: '', status: 'open', archived: 'active', pipelineId: '', stageId: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const guard = useDraftGuard();
  const content = useRef<HTMLDivElement>(null);

  // Pipelines with their stages, and the team (for owners). Read only: never creates a pipeline.
  const ref = useLoad<SalesRef>(`sales-ref|${slug}`, async (signal): Promise<Outcome<SalesRef>> => {
    const pipelines = await sales.pipelines(slug, signal);
    if (pipelines.kind !== 'ok') return pipelines;
    const withStages: SalesRef['pipelines'] = [];
    for (const pipeline of pipelines.data) {
      const stages = await sales.stages(slug, pipeline.id, signal);
      if (stages.kind !== 'ok') return stages;
      withStages.push(stages.data);
    }
    const members = await customers.members(slug, signal);
    return { kind: 'ok', data: { pipelines: withStages, members: members.kind === 'ok' ? members.data : [] } };
  });

  // Customer and contact names for the ids on screen. One request per id, once; a business switch remounts the Zone.
  const [customerNames, setCustomerNames] = useState<Record<string, string | null>>({});
  const [contactNames, setContactNames] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true; // StrictMode mounts effects twice: set again on every mount
    return () => {
      live.current = false;
    };
  }, []);
  const want = useCallback<Names['want']>(({ customers: cIds = [], contacts: kIds = [] }) => {
    for (const id of new Set(cIds.filter((x): x is string => Boolean(x)))) {
      if (asked.current.has(`c:${id}`)) continue;
      asked.current.add(`c:${id}`);
      void customers.get(slug, id).then((o) => live.current && setCustomerNames((n) => ({ ...n, [id]: o.kind === 'ok' ? o.data.displayName : null })));
    }
    for (const id of new Set(kIds.filter((x): x is string => Boolean(x)))) {
      if (asked.current.has(`k:${id}`)) continue;
      asked.current.add(`k:${id}`);
      void customers.getContact(slug, id).then((o) => live.current && setContactNames((n) => ({ ...n, [id]: o.kind === 'ok' ? o.data.displayName : null })));
    }
  }, [customers, slug]);
  const names: Names = { customer: (id) => (id ? customerNames[id] ?? null : null), contact: (id) => (id ? contactNames[id] ?? null : null), want };
  const remember = (o: Opportunity, customerName: string | null, contactName: string | null) => {
    if (o.customerId && customerName) setCustomerNames((n) => ({ ...n, [o.customerId!]: customerName }));
    if (o.contactId && contactName) setContactNames((n) => ({ ...n, [o.contactId!]: contactName }));
  };

  const go = (next: View, message: string | null = null) => {
    guard.clearDrafts();
    setNotice(message);
    setView(next);
  };
  const { markDraft } = guard;
  const markForm = useCallback((dirty: boolean) => markDraft('form', dirty), [markDraft]);

  // The default pipeline is set up only by an explicit action (POST), never by viewing Sales.
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [addAfterSetUp, setAddAfterSetUp] = useState(false);
  const setUp = async (thenAdd = false) => {
    setSettingUp(null);
    const result = await sales.initialiseDefault(slug);
    if (result.kind === 'ok') {
      setAddAfterSetUp(thenAdd);
      ref.reload(); // the form opens once the new pipeline and its stages have loaded (below)
      return;
    }
    if (result.kind === 'unauthenticated') return onSessionEnded();
    setSettingUp(result.kind === 'forbidden' ? 'Your role cannot set up Sales in this business.' : result.kind === 'unreachable' ? "Can't reach Business OS. Nothing was set up; try again." : 'Sales could not be set up. Nothing was changed.');
  };

  const viewKey = view.name === 'detail' ? `detail:${view.id}` : view.name === 'edit' ? `edit:${view.opportunity.id}` : view.name;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  const refData = ref.state.status === 'done' && ref.state.outcome.kind === 'ok' ? ref.state.outcome.data : ref.previous?.kind === 'ok' ? ref.previous.data : null;
  const ready = ref.state.status === 'done' && refData !== null && refData.pipelines.length > 0;
  if (addAfterSetUp && ready) {
    // Adjusting state while rendering (React's documented pattern): open the form once set-up has loaded.
    setAddAfterSetUp(false);
    go({ name: 'new' });
  }

  return (
    <ZoneFrame zone="Sales" business={name} user={userLabel} onHome={() => guard.leave(onHome)} onSwitch={() => guard.leave(onSwitch)} onSignOut={() => guard.leave(onSignOut)}>
      <div ref={content}>
        {notice ? <p role="status" className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}
        {settingUp ? <p role="alert" className="mb-5 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">{settingUp}</p> : null}
        {!refData && ref.state.status === 'loading' ? <><h1 className="sr-only">Sales</h1><Skeleton label="Loading Sales…" /></> : null}
        {!refData && ref.state.status === 'done' && ref.state.outcome.kind !== 'ok' ? (
          <><h1 className="mb-6 text-3xl font-semibold tracking-tight">Sales</h1><Problem outcome={ref.state.outcome} what="Sales" onRetry={ref.reload} onSessionEnded={onSessionEnded} /></>
        ) : null}
        {refData && view.name === 'list' ? (
          <OpportunityList
            sales={sales} slug={slug} locale={locale} refData={refData} names={names} query={query} onQuery={setQuery} canWrite={canWrite}
            onOpen={(id) => go({ name: 'detail', id })}
            onAdd={() => (refData.pipelines.length ? go({ name: 'new' }) : void setUp(true))}
            onSetUp={() => void setUp()} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {refData && view.name === 'detail' ? (
          <OpportunityDetail
            sales={sales} slug={slug} id={view.id} locale={locale} timeZone={timeZone} refData={refData} names={names} canWrite={canWrite}
            onBack={() => guard.leave(() => go({ name: 'list' }))} onEdit={(opportunity) => guard.leave(() => go({ name: 'edit', opportunity }))}
            confirmLeave={guard.leave} onDraftChange={guard.markDraft} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {refData && (view.name === 'new' || view.name === 'edit') ? (
          <OpportunityForm
            key={view.name === 'edit' ? view.opportunity.id : 'new'}
            sales={sales} customers={customers} slug={slug} locale={locale} businessCurrency={currency} refData={refData} names={names}
            opportunity={view.name === 'edit' ? view.opportunity : undefined}
            onDirtyChange={markForm} onSessionEnded={onSessionEnded}
            onCancel={() => guard.leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.opportunity.id } : { name: 'list' }))}
            onSaved={(saved, customerName, contactName) => {
              remember(saved, customerName, contactName);
              go({ name: 'detail', id: saved.id }, view.name === 'edit' ? 'Changes saved.' : `${saved.title} was added.`);
            }}
          />
        ) : null}
      </div>
      {guard.dialog}
    </ZoneFrame>
  );
}
