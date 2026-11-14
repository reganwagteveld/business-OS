import type { Opportunity } from '@business-os/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { actionClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLayout } from '../use-layout';
import { useLoad } from '../use-load';
import { formatDate, formatMoney, STATUS_LABEL } from './format';
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
  onAdd: () => void;
  onSessionEnded: () => void;
}

const ALL_LIMIT = 200;

export function PipelineBoard({ sales, slug, locale, refData, names, canWrite, onOpen, onAdd, onSessionEnded }: BoardProps) {
  const uid = useId();
  const pipeline = refData.pipelines[0];
  if (!pipeline) return null;

  const { state, reload } = useLoad(`board|${slug}|${pipeline.pipeline.id}`, (signal) =>
    sales.list(slug, { status: 'all', archived: 'active', pipelineId: pipeline.pipeline.id, limit: ALL_LIMIT }, signal));

  const serverRows = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data.opportunities : null;
  const [optimistic, setOptimistic] = useState<Map<string, { stageId: string; version: number }>>(new Map());
  const rows = serverRows?.map((o) => {
    const patch = optimistic.get(o.id);
    return patch ? { ...o, stageId: patch.stageId, version: patch.version } : o;
  }) ?? null;

  const { want } = names;
  useEffect(() => {
    if (rows) want({ customers: rows.map((r) => r.customerId), contacts: rows.map((r) => r.contactId) });
  }, [serverRows, want]);

  const stages = pipeline.stages;
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const moveOpp = useCallback(async (opp: Opportunity, toStageId: string) => {
    if (opp.stageId === toStageId || opp.status !== 'OPEN' || moving.has(opp.id)) return;
    setMoving((s) => new Set(s).add(opp.id));
    setOptimistic((m) => new Map(m).set(opp.id, { stageId: toStageId, version: opp.version + 1 }));
    setError(null);
    const result = await sales.update(slug, opp.id, { version: opp.version, stageId: toStageId });
    setMoving((s) => { const next = new Set(s); next.delete(opp.id); return next; });
    if (result.kind === 'ok') {
      setOptimistic((m) => { const next = new Map(m); next.delete(opp.id); return next; });
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
  }, [sales, slug, moving, reload, onSessionEnded]);

  const onDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };
  const onDragEnd = () => { setDragId(null); setDropTarget(null); };
  const onDragOver = (e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(stageId);
  };
  const onDragLeave = (e: React.DragEvent, stageId: string) => {
    if (dropTarget === stageId) setDropTarget(null);
  };
  const onDrop = (e: React.DragEvent, stageId: string) => {
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData('text/plain');
    const opp = rows?.find((o) => o.id === id);
    if (opp) void moveOpp(opp, stageId);
  };

  const layout = useLayout();
  const boardRef = useRef<HTMLDivElement>(null);

  if (!serverRows && state.status === 'loading') return <Skeleton label="Loading pipeline board…" />;
  if (!serverRows && state.status === 'done' && state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="Pipeline board" onRetry={reload} onSessionEnded={onSessionEnded} />;
  if (!rows) return null;

  const openOpps = rows.filter((o) => o.status === 'OPEN');
  const wonOpps = rows.filter((o) => o.status === 'WON');
  const lostOpps = rows.filter((o) => o.status === 'LOST');
  const columnWidth = layout === 'narrow' ? 'min-w-[280px]' : 'min-w-[300px]';

  return (
    <section aria-labelledby={`${uid}-board`}>
      {error ? (
        <div role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      ) : null}
      {state.status === 'done' && state.outcome.kind === 'ok' && state.outcome.data.nextCursor ? (
        <p className="mb-3 text-xs text-muted-foreground">Showing the first {ALL_LIMIT} opportunities. Use the list view for older records.</p>
      ) : null}
      <div ref={boardRef} className="flex gap-4 overflow-x-auto pb-4" role="region" aria-label="Pipeline board" tabIndex={0}>
        {stages.map((stage) => {
          const cards = openOpps.filter((o) => o.stageId === stage.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const total = cards.reduce((sum, o) => sum + (o.amount ? parseFloat(o.amount) : 0), 0);
          const isTarget = dropTarget === stage.id;
          return (
            <div
              key={stage.id}
              className={`${columnWidth} flex-shrink-0 rounded-2xl border bg-card ${isTarget ? 'border-primary ring-2 ring-primary/30' : 'border-border'}`}
              onDragOver={(e) => onDragOver(e, stage.id)}
              onDragLeave={(e) => onDragLeave(e, stage.id)}
              onDrop={(e) => onDrop(e, stage.id)}
              role="group"
              aria-label={`${stage.name}: ${cards.length} ${cards.length === 1 ? 'opportunity' : 'opportunities'}`}
            >
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{stage.name}</h3>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{cards.length}</span>
                </div>
                {total > 0 ? (
                  <p className="mt-1 text-xs tabular-nums text-muted-foreground">
                    {formatMoney(total.toFixed(2), cards[0]?.currencyCode ?? 'AUD', locale)}
                  </p>
                ) : null}
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
                      isMoving={moving.has(opp.id)}
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
        <OutcomeColumn label="Won" status="WON" opps={wonOpps} names={names} locale={locale} refData={refData} columnWidth={columnWidth} onOpen={onOpen} />
        <OutcomeColumn label="Lost" status="LOST" opps={lostOpps} names={names} locale={locale} refData={refData} columnWidth={columnWidth} onOpen={onOpen} />
      </div>
    </section>
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
      draggable={canWrite}
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

function OutcomeColumn({ label, status, opps, names, locale, refData, columnWidth, onOpen }: {
  label: string; status: 'WON' | 'LOST'; opps: Opportunity[]; names: Names; locale?: string; refData: SalesRef; columnWidth: string; onOpen: (id: string) => void;
}) {
  const sorted = [...opps].sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt));
  const total = sorted.reduce((sum, o) => sum + (o.amount ? parseFloat(o.amount) : 0), 0);
  const tone = status === 'WON' ? 'border-primary/40 bg-primary/5' : 'border-muted-foreground/30 bg-muted/30';
  return (
    <div className={`${columnWidth} flex-shrink-0 rounded-2xl border ${tone}`} role="group" aria-label={`${label}: ${sorted.length} ${sorted.length === 1 ? 'opportunity' : 'opportunities'}`}>
      <div className="border-b border-border/50 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{sorted.length}</span>
        </div>
        {total > 0 ? (
          <p className="mt-1 text-xs tabular-nums text-muted-foreground">
            {formatMoney(total.toFixed(2), sorted[0]?.currencyCode ?? 'AUD', locale)}
          </p>
        ) : null}
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
