import type { Opportunity } from '@business-os/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { Problem, Skeleton } from '../problem';
import { useLayout } from '../use-layout';
import { useLoad } from '../use-load';
import { formatDate, formatMoney } from './format';
import { OutcomeBadge, ownerName } from './opportunity-list';
import type { Names, SalesRef } from './types';

interface BoardProps {
  sales: SalesClient;
  slug: string;
  locale?: string;
  refData: SalesRef;
  names: Names;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onSessionEnded: () => void;
}

const ALL_LIMIT = 200;

interface CurrencyTotal { currency: string; total: number }

function groupByCurrency(opps: Opportunity[]): CurrencyTotal[] {
  const map = new Map<string, number>();
  for (const o of opps) {
    if (o.amount !== null) {
      const cur = o.currencyCode;
      map.set(cur, (map.get(cur) ?? 0) + parseFloat(o.amount));
    }
  }
  return [...map.entries()].map(([currency, total]) => ({ currency, total }));
}

function TotalLine({ totals, locale, partial }: { totals: CurrencyTotal[]; locale?: string; partial: boolean }) {
  if (totals.length === 0) return null;
  return (
    <p className="mt-1 text-xs tabular-nums text-muted-foreground">
      {totals.map((t, i) => (
        <span key={t.currency}>{i > 0 ? ' + ' : ''}{formatMoney(t.total.toFixed(2), t.currency, locale)}</span>
      ))}
      {partial ? <span title="Not all opportunities are loaded"> +</span> : null}
    </p>
  );
}

export function PipelineBoard({ sales, slug, locale, refData, names, canWrite, onOpen, onSessionEnded }: BoardProps) {
  const uid = useId();
  const layout = useLayout();
  const boardRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(new Set<string>());
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set());

  const pipeline = refData.pipelines[0];
  const pipelineId = pipeline?.pipeline.id ?? '';

  type PageData = { opportunities: Opportunity[]; nextCursor: string | null };
  const [lastGood, setLastGood] = useState<PageData | null>(null);
  const { state, reload } = useLoad(`board|${slug}|${pipelineId}`, async (signal) => {
    if (!pipelineId) return { kind: 'ok' as const, data: { opportunities: [] as Opportunity[], nextCursor: null } };
    const result = await sales.list(slug, { status: 'all', archived: 'active', pipelineId, limit: ALL_LIMIT }, signal);
    if (result.kind === 'ok') setLastGood(result.data);
    return result;
  });

  const freshData = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const serverRows = (freshData ?? lastGood)?.opportunities ?? null;
  const partial = (freshData ?? lastGood)?.nextCursor !== null && (freshData ?? lastGood) !== null;
  const [optimistic, setOptimistic] = useState<Map<string, { stageId: string; version: number }>>(new Map());
  const rows = serverRows?.map((o) => {
    const patch = optimistic.get(o.id);
    return patch ? { ...o, stageId: patch.stageId, version: patch.version } : o;
  }) ?? null;

  const { want } = names;
  useEffect(() => {
    if (serverRows) want({ customers: serverRows.map((r) => r.customerId), contacts: serverRows.map((r) => r.contactId) });
  }, [serverRows, want]);

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const moveOpp = useCallback(async (opp: Opportunity, toStageId: string) => {
    if (opp.stageId === toStageId || opp.status !== 'OPEN') return;
    if (inFlight.current.has(opp.id)) return;
    inFlight.current.add(opp.id);
    setMovingIds((s) => new Set(s).add(opp.id));
    setOptimistic((m) => new Map(m).set(opp.id, { stageId: toStageId, version: opp.version + 1 }));
    setError(null);
    try {
      const result = await sales.update(slug, opp.id, { version: opp.version, stageId: toStageId });
      if (result.kind === 'ok') {
        setOptimistic((m) => {
          const next = new Map(m);
          next.set(opp.id, { stageId: result.data.stageId, version: result.data.version });
          return next;
        });
        reload();
        return;
      }
      setOptimistic((m) => { const next = new Map(m); next.delete(opp.id); return next; });
      if (result.kind === 'unauthenticated') { onSessionEnded(); return; }
      if (result.kind === 'conflict' && result.code === 'stale') {
        setError(`"${opp.title}" was changed by someone else. The board has been refreshed.`);
        reload();
        return;
      }
      setError(`Could not move "${opp.title}": ${explainMove(result)}`);
      reload();
    } finally {
      inFlight.current.delete(opp.id);
      setMovingIds((s) => { const next = new Set(s); next.delete(opp.id); return next; });
    }
  }, [sales, slug, reload, onSessionEnded]);

  // When server data arrives, clear optimistic entries that the server has caught up with.
  useEffect(() => {
    if (!serverRows) return;
    setOptimistic((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [id, patch] of prev) {
        const server = serverRows.find((o) => o.id === id);
        if (server && server.stageId === patch.stageId && server.version >= patch.version && !inFlight.current.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [serverRows]);

  const onDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);
  const onDragEnd = useCallback(() => { setDragId(null); setDropTarget(null); }, []);
  const onDragOver = useCallback((e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(stageId);
  }, []);
  const onDragLeave = useCallback((_e: React.DragEvent, stageId: string) => {
    setDropTarget((prev) => (prev === stageId ? null : prev));
  }, []);
  const onDrop = useCallback((e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData('text/plain');
    if (!rows) return;
    const opp = rows.find((o) => o.id === id);
    if (opp) void moveOpp(opp, stageId);
  }, [rows, moveOpp]);

  if (!pipeline) return null;
  if (!serverRows && state.status === 'loading') return <Skeleton label="Loading pipeline board…" />;
  if (!serverRows && state.status === 'done' && state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Pipeline board" onRetry={reload} onSessionEnded={onSessionEnded} />;
  if (!rows) return null;

  const stages = pipeline.stages;
  const openOpps = rows.filter((o) => o.status === 'OPEN');
  const wonOpps = rows.filter((o) => o.status === 'WON');
  const lostOpps = rows.filter((o) => o.status === 'LOST');
  const columnWidth = layout === 'narrow' ? 'min-w-[280px]' : 'min-w-[300px]';

  return (
    <div>
      <h2 id={`${uid}-board`} className="sr-only">Pipeline board</h2>
      {error ? (
        <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}
      {partial ? (
        <p role="note" className="mb-3 text-xs text-muted-foreground">
          Showing the first {ALL_LIMIT} opportunities. Counts and totals may be incomplete. Use the list view for the full set.
        </p>
      ) : null}
      <div ref={boardRef} className="flex gap-4 overflow-x-auto pb-4" role="region" aria-label="Pipeline board" tabIndex={0}>
        {stages.map((stage) => {
          const cards = openOpps.filter((o) => o.stageId === stage.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const totals = groupByCurrency(cards);
          const isTarget = dropTarget === stage.id;
          return (
            <div
              key={stage.id}
              className={`${columnWidth} flex-shrink-0 rounded-2xl border bg-card ${isTarget ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
              onDragOver={(e) => onDragOver(e, stage.id)}
              onDragLeave={(e) => onDragLeave(e, stage.id)}
              onDrop={(e) => onDrop(e, stage.id)}
              role="group"
              aria-label={`${stage.name}: ${cards.length}${partial ? '+' : ''} ${cards.length === 1 ? 'opportunity' : 'opportunities'}`}
            >
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{stage.name}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{cards.length}{partial ? '+' : ''}</span>
                </div>
                <TotalLine totals={totals} locale={locale} partial={partial} />
              </div>
              <div className="space-y-2 p-3" style={{ minHeight: '4rem' }}>
                {cards.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">No opportunities</p>
                ) : (
                  cards.map((opp) => (
                    <OpportunityCard
                      key={opp.id}
                      opp={opp}
                      names={names}
                      locale={locale}
                      refData={refData}
                      stages={stages}
                      dragging={dragId === opp.id}
                      isMoving={movingIds.has(opp.id)}
                      canWrite={canWrite}
                      onOpen={onOpen}
                      onMove={(stageId) => void moveOpp(opp, stageId)}
                      onDragStart={(e) => onDragStart(e, opp.id)}
                      onDragEnd={onDragEnd}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
        <OutcomeColumn label="Won" status="WON" opps={wonOpps} names={names} locale={locale} columnWidth={columnWidth} onOpen={onOpen} partial={partial} />
        <OutcomeColumn label="Lost" status="LOST" opps={lostOpps} names={names} locale={locale} columnWidth={columnWidth} onOpen={onOpen} partial={partial} />
      </div>
    </div>
  );
}

function OpportunityCard({ opp, names, locale, refData, stages, dragging, isMoving, canWrite, onOpen, onMove, onDragStart, onDragEnd }: {
  opp: Opportunity; names: Names; locale?: string; refData: SalesRef;
  stages: { id: string; name: string }[];
  dragging: boolean; isMoving: boolean; canWrite: boolean;
  onOpen: (id: string) => void; onMove: (stageId: string) => void;
  onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void;
}) {
  const uid = useId();
  const who = [names.customer(opp.customerId), names.contact(opp.contactId)].filter(Boolean).join(' · ');
  return (
    <div
      className={`rounded-xl border bg-background p-3 transition-shadow ${dragging ? 'border-primary opacity-50' : 'border-border'} ${isMoving ? 'opacity-60' : ''} ${canWrite ? 'cursor-grab active:cursor-grabbing' : ''}`}
      draggable={canWrite && !isMoving}
      onDragStart={canWrite ? onDragStart : undefined}
      onDragEnd={canWrite ? onDragEnd : undefined}
      aria-label={opp.title}
    >
      <button
        type="button"
        onClick={() => onOpen(opp.id)}
        className="block w-full text-left text-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]"
      >
        {opp.title}
      </button>
      {who ? <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{who}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {opp.amount !== null ? <span className="tabular-nums">{formatMoney(opp.amount, opp.currencyCode, locale)}</span> : null}
        {opp.expectedCloseDate ? <span>{formatDate(opp.expectedCloseDate, locale)}</span> : null}
        {ownerName(refData, opp.ownerUserId) ? <span>{ownerName(refData, opp.ownerUserId)}</span> : null}
      </div>
      {canWrite && stages.length > 1 ? (
        <div className="mt-2">
          <label htmlFor={`${uid}-move`} className="sr-only">Move to stage</label>
          <select
            id={`${uid}-move`}
            value={opp.stageId}
            onChange={(e) => onMove(e.target.value)}
            disabled={isMoving}
            className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Move "${opp.title}" to stage`}
          >
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function OutcomeColumn({ label, status, opps, names, locale, columnWidth, onOpen, partial }: {
  label: string; status: 'WON' | 'LOST'; opps: Opportunity[]; names: Names; locale?: string; columnWidth: string; onOpen: (id: string) => void; partial: boolean;
}) {
  const sorted = [...opps].sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt));
  const totals = groupByCurrency(sorted);
  const tone = status === 'WON' ? 'border-primary/40 bg-primary/5' : 'border-muted-foreground/30 bg-muted/30';
  return (
    <div className={`${columnWidth} flex-shrink-0 rounded-2xl border ${tone}`} role="group" aria-label={`${label}: ${sorted.length}${partial ? '+' : ''} ${sorted.length === 1 ? 'opportunity' : 'opportunities'}`}>
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{sorted.length}{partial ? '+' : ''}</span>
        </div>
        <TotalLine totals={totals} locale={locale} partial={partial} />
      </div>
      <div className="space-y-2 p-3" style={{ minHeight: '4rem' }}>
        {sorted.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">None yet</p>
        ) : (
          sorted.map((opp) => {
            const who = [names.customer(opp.customerId), names.contact(opp.contactId)].filter(Boolean).join(' · ');
            return (
              <div key={opp.id} className={`rounded-xl border bg-background p-3 ${status === 'LOST' ? 'opacity-60' : ''}`}>
                <button type="button" onClick={() => onOpen(opp.id)}
                  className="block w-full text-left text-sm font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [overflow-wrap:anywhere]">
                  {opp.title}
                </button>
                {who ? <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">{who}</p> : null}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <OutcomeBadge status={opp.status} />
                  {opp.amount !== null ? <span className="tabular-nums">{formatMoney(opp.amount, opp.currencyCode, locale)}</span> : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function explainMove(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>): string {
  if (outcome.kind === 'conflict') {
    switch (outcome.code) {
      case 'stale': return 'it was changed by someone else';
      case 'not_open': return 'it is already won or lost';
      case 'archived': return 'it is archived';
      default: return 'the change was refused';
    }
  }
  switch (outcome.kind) {
    case 'forbidden': return 'your role does not allow this';
    case 'not_found': return 'it no longer exists';
    case 'unreachable': return "Business OS didn't respond — try again";
    case 'invalid_input': return outcome.message;
    default: return 'something went wrong';
  }
}
