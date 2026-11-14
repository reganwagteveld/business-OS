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
import { PipelineBoard } from './pipeline-board';
import type { Names, SalesRef } from './types';

export type { Names, SalesRef } from './types';

type ListMode = 'list' | 'board';
type View = { name: 'list' } | { name: 'board' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; opportunity: Opportunity };

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
  const [listMode, setListMode] = useState<ListMode>('list');
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
    if (result.kind === 'unreachable' || result.kind === 'failed' || result.kind === 'invalid') {
      // No answer (or an unreadable one) does not mean nothing happened: the server may have set it up.
      // Re-read the pipelines (read only) so the screen shows what is actually there. Setting up again
      // is safe: it is idempotent and never creates a second pipeline.
      setAddAfterSetUp(thenAdd);
      ref.reload();
      setSettingUp("Business OS didn't confirm the set-up, so it may or may not have happened. We're checking; if Sales still isn't set up, try again (it is safe to repeat).");
      return;
    }
    setSettingUp(result.kind === 'forbidden' ? 'Your role cannot set up Sales in this business.' : 'Sales could not be set up. Nothing was changed.');
  };

  const mainView: View = listMode === 'board' ? { name: 'board' } : { name: 'list' };
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
  if (settingUp && settingUp.startsWith("Business OS didn't confirm") && ready) {
    setSettingUp(null);
    setNotice('Sales is set up.');
  }
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
        {refData && (view.name === 'list' || view.name === 'board') ? (
          listMode === 'board' && refData.pipelines.length > 0 ? (
            <>
              <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight">Sales</h1>
                  <p className="mt-1 text-sm text-muted-foreground">Opportunities with your customers, from first contact to won or lost.</p>
                </div>
                <div className="flex items-center gap-3">
                  <ViewToggle mode={listMode} onMode={(m) => { setListMode(m); setView(m === 'board' ? { name: 'board' } : { name: 'list' }); }} />
                  {canWrite ? <button type="button" className="rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => go({ name: 'new' })}>Add opportunity</button> : null}
                </div>
              </div>
              <PipelineBoard
                sales={sales} slug={slug} locale={locale} refData={refData} names={names} canWrite={canWrite}
                onOpen={(id) => go({ name: 'detail', id })}
                onSessionEnded={onSessionEnded}
              />
            </>
          ) : (
            <OpportunityList
              sales={sales} slug={slug} locale={locale} refData={refData} names={names} query={query} onQuery={setQuery} canWrite={canWrite}
              onOpen={(id) => go({ name: 'detail', id })}
              onAdd={() => (refData.pipelines.length ? go({ name: 'new' }) : void setUp(true))}
              onSetUp={() => void setUp()} onSessionEnded={onSessionEnded}
              viewToggle={refData.pipelines.length > 0 ? <ViewToggle mode={listMode} onMode={(m) => { setListMode(m); setView(m === 'board' ? { name: 'board' } : { name: 'list' }); }} /> : undefined}
            />
          )
        ) : null}
        {refData && view.name === 'detail' ? (
          <OpportunityDetail
            sales={sales} slug={slug} id={view.id} locale={locale} timeZone={timeZone} refData={refData} names={names} canWrite={canWrite}
            onBack={() => guard.leave(() => go(mainView))} onEdit={(opportunity) => guard.leave(() => go({ name: 'edit', opportunity }))}
            confirmLeave={guard.leave} onDraftChange={guard.markDraft} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {refData && (view.name === 'new' || view.name === 'edit') ? (
          <OpportunityForm
            key={view.name === 'edit' ? view.opportunity.id : 'new'}
            sales={sales} customers={customers} slug={slug} locale={locale} businessCurrency={currency} refData={refData} names={names}
            opportunity={view.name === 'edit' ? view.opportunity : undefined}
            onDirtyChange={markForm} onSessionEnded={onSessionEnded}
            onCancel={() => guard.leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.opportunity.id } : mainView))}
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

function ViewToggle({ mode, onMode }: { mode: ListMode; onMode: (m: ListMode) => void }) {
  return (
    <div role="group" aria-label="View mode" className="inline-flex rounded-xl border border-border p-1">
      <button type="button" aria-pressed={mode === 'list'} onClick={() => onMode('list')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${mode === 'list' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
        List
      </button>
      <button type="button" aria-pressed={mode === 'board'} onClick={() => onMode('board')}
        className={`rounded-lg px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${mode === 'board' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
        Board
      </button>
    </div>
  );
}
