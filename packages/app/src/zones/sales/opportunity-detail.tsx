import type { Opportunity } from '@business-os/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { useDialog } from '../dialog';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { formatDate, formatMoney, formatWhen } from './format';
import { OutcomeBadge, ownerName, stageLabel } from './opportunity-list';
import type { Names, SalesRef } from './types';

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

/** Plain words for a refused lifecycle change. The record is reloaded so the screen shows the truth. */
function explain(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>): string {
  if (outcome.kind === 'conflict') {
    switch (outcome.code) {
      case 'stale': return 'Someone else changed this opportunity a moment ago. The latest version is shown; check it and try again.';
      case 'not_open': return 'This opportunity was already won or lost (perhaps by someone else). The latest version is shown.';
      case 'not_closed': return 'This opportunity is already open. The latest version is shown.';
      case 'archived': return 'This opportunity is archived. Restore it first.';
      case 'not_archived': return 'This opportunity is not archived. The latest version is shown.';
      case 'archived_reference': return 'That stage has been archived. Choose another.';
      default: return 'This change could not be made. The latest version is shown.';
    }
  }
  switch (outcome.kind) {
    case 'invalid_input': return outcome.message;
    case 'forbidden': return 'Your role does not allow this.';
    case 'not_found': return 'This opportunity no longer exists in this business.';
    case 'unreachable': return "Business OS didn't answer, so this may or may not have happened. The latest version is being loaded; check it before trying again.";
    default: return 'Something went wrong. Nothing was changed.';
  }
}

type Dialog = { kind: 'win' } | { kind: 'lose' } | { kind: 'reopen' } | { kind: 'archive' };

/**
 * One opportunity: everything about it, its won/lost history, and the actions a person with
 * sales:write may take. Status only changes through the win, lose and reopen endpoints; a stage move
 * is an edit that names the version it was based on.
 */
export function OpportunityDetail({ sales, slug, id, locale, timeZone, refData, names, canWrite, onBack, onEdit, confirmLeave, onDraftChange, onSessionEnded }: {
  sales: SalesClient; slug: string; id: string; locale?: string; timeZone: string; refData: SalesRef; names: Names; canWrite: boolean;
  onBack: () => void; onEdit: (o: Opportunity) => void; confirmLeave: (action: () => void) => void;
  onDraftChange: (key: string, dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const opp = useLoad(`opp|${slug}|${id}`, (signal) => sales.get(slug, id, signal));
  const history = useLoad(`outcomes|${slug}|${id}`, (signal) => sales.outcomes(slug, id, signal));
  const shown = opp.state.status === 'done' ? (opp.state.outcome.kind === 'ok' ? opp.state.outcome.data : null) : opp.previous?.kind === 'ok' ? opp.previous.data : null;
  const { want } = names;
  useEffect(() => {
    if (shown) want({ customers: [shown.customerId], contacts: [shown.contactId] });
  }, [shown, want]);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [reason, setReason] = useState('');
  const [reopenStage, setReopenStage] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const inFlight = useRef(false);
  const close = () => {
    setDialog(null);
    setReason('');
  };
  const { ref: dialogRef, onKeyDown: onDialogKey } = useDialog(dialog !== null, () => (reason.trim() ? confirmLeave(close) : close()));
  // A typed loss reason is unsaved work: leaving asks first.
  useEffect(() => onDraftChange('lose-reason', dialog?.kind === 'lose' && reason.trim() !== ''), [dialog, reason, onDraftChange]);
  useEffect(() => () => onDraftChange('lose-reason', false), [onDraftChange]);

  const refresh = () => {
    opp.reload();
    history.reload();
  };
  async function act(label: string, run: () => Promise<Outcome<Opportunity>>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    let outcome: Outcome<Opportunity>;
    try {
      outcome = await run();
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'ok') {
      close();
      setMessage({ tone: 'ok', text: label });
    } else {
      // The dialog and anything typed in it (a loss reason) stay until the outcome is known: either the
      // person tries again or cancels, or the reloaded record shows the change did happen (below).
      setMessage({ tone: 'error', text: explain(outcome) });
    }
    if (!(outcome.kind === 'invalid_input' || outcome.kind === 'forbidden')) refresh();
  }

  // A request that got no answer may still have worked. Once the reloaded record shows the action took
  // effect, the dialog has nothing left to do: close it and say so. Until then it (and its text) stays.
  const done = shown && dialog && opp.state.status === 'done' && (
    (dialog.kind === 'win' && shown.status === 'WON') || (dialog.kind === 'lose' && shown.status === 'LOST')
    || (dialog.kind === 'reopen' && shown.status === 'OPEN') || (dialog.kind === 'archive' && shown.archivedAt !== null));
  if (done && dialog) {
    setDialog(null);
    setReason('');
    setMessage({ tone: 'ok', text: 'The latest version shows this change was made.' });
  }

  if (!shown) {
    return (
      <div>
        <BackButton onBack={onBack} />
        {opp.state.status === 'loading' ? <Skeleton rows={4} label="Loading opportunity…" /> : null}
        {opp.state.status === 'done' && opp.state.outcome.kind !== 'ok' ? <Problem outcome={opp.state.outcome} what="This opportunity" onRetry={opp.reload} onSessionEnded={onSessionEnded} /> : null}
      </div>
    );
  }

  const o = shown;
  const archived = o.archivedAt !== null;
  const isOpen = o.status === 'OPEN';
  const editable = canWrite && !archived;
  const stages = refData.pipelines.find((p) => p.pipeline.id === o.pipelineId)?.stages ?? [];
  const customer = o.customerId ? names.customer(o.customerId) ?? 'Loading…' : null;
  const contact = o.contactId ? names.contact(o.contactId) ?? 'Loading…' : null;

  return (
    <div>
      <BackButton onBack={onBack} />
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{o.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <OutcomeBadge status={o.status} archived={archived} />
            <span>{stageLabel(refData, o.pipelineId, o.stageId)}</span>
            <span aria-hidden="true">·</span>
            <span className="font-medium text-foreground tabular-nums">{formatMoney(o.amount, o.currencyCode, locale)}</span>
          </div>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {editable ? <button type="button" className={secondaryClass} onClick={() => onEdit(o)}>Edit</button> : null}
            {editable && isOpen ? <button type="button" className={actionClass} disabled={busy} onClick={() => setDialog({ kind: 'win' })}>Mark won</button> : null}
            {editable && isOpen ? <button type="button" className={secondaryClass} disabled={busy} onClick={() => setDialog({ kind: 'lose' })}>Mark lost</button> : null}
            {editable && !isOpen ? <button type="button" className={secondaryClass} disabled={busy} onClick={() => { setReopenStage(o.stageId); setDialog({ kind: 'reopen' }); }}>Reopen</button> : null}
            {archived
              ? <button type="button" className={actionClass} disabled={busy} onClick={() => void act('Opportunity restored.', () => sales.restore(slug, o.id))}>{busy ? 'Restoring…' : 'Restore'}</button>
              : <button type="button" className={secondaryClass} disabled={busy} onClick={() => setDialog({ kind: 'archive' })}>Archive</button>}
          </div>
        ) : null}
      </header>

      {message && !(dialog && message.tone === 'error') ? (
        <p role={message.tone === 'ok' ? 'status' : 'alert'} className={`mb-5 rounded-xl border px-4 py-3 text-sm ${message.tone === 'ok' ? 'border-border bg-muted' : 'border-destructive/40 bg-destructive/5 text-destructive'}`}>{message.text}</p>
      ) : null}
      {archived ? <p role="status" className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-sm">This opportunity is archived. It is hidden from the main list and cannot be changed until it is restored.</p> : null}

      {dialog ? (
        <div ref={dialogRef} onKeyDown={onDialogKey} role="alertdialog" aria-labelledby={`${uid}-dlg-title`} aria-describedby={`${uid}-dlg-body`} className="mb-6 rounded-2xl border border-border bg-card p-5">
          {message?.tone === 'error' ? <p role="alert" className="mb-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{message.text}</p> : null}
          {dialog.kind === 'win' ? (
            <>
              <h2 id={`${uid}-dlg-title`} className="text-base font-semibold">Mark “{o.title}” as won?</h2>
              <p id={`${uid}-dlg-body`} className="mt-1 text-sm text-muted-foreground">It closes in its current stage. You can reopen it later if needed; the history keeps the win.</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className={actionClass} disabled={busy} onClick={() => void act('Marked as won.', () => sales.win(slug, o.id))}>{busy ? 'Saving…' : 'Mark won'}</button>
                <button type="button" autoFocus className={secondaryClass} disabled={busy} onClick={close}>Cancel</button>
              </div>
            </>
          ) : null}
          {dialog.kind === 'lose' ? (
            <>
              <h2 id={`${uid}-dlg-title`} className="text-base font-semibold">Mark “{o.title}” as lost?</h2>
              <p id={`${uid}-dlg-body`} className="mt-1 text-sm text-muted-foreground">Optionally say why. The reason is kept in this opportunity's history, even if it is reopened.</p>
              <label htmlFor={`${uid}-reason`} className="mt-3 mb-1 block text-sm font-medium">Reason (optional)</label>
              <textarea id={`${uid}-reason`} autoFocus rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className={actionClass} disabled={busy} onClick={() => void act('Marked as lost.', () => sales.lose(slug, o.id, { lossReason: reason.trim() }))}>{busy ? 'Saving…' : 'Mark lost'}</button>
                <button type="button" className={secondaryClass} disabled={busy} onClick={() => (reason.trim() ? confirmLeave(close) : close())}>Cancel</button>
              </div>
            </>
          ) : null}
          {dialog.kind === 'reopen' ? (
            <>
              <h2 id={`${uid}-dlg-title`} className="text-base font-semibold">Reopen “{o.title}”?</h2>
              <p id={`${uid}-dlg-body`} className="mt-1 text-sm text-muted-foreground">It becomes open again. Its {o.status === 'WON' ? 'win' : 'loss'} stays in the history.</p>
              <label htmlFor={`${uid}-reopen-stage`} className="mt-3 mb-1 block text-sm font-medium">Reopen in stage</label>
              <select id={`${uid}-reopen-stage`} autoFocus value={reopenStage} onChange={(e) => setReopenStage(e.target.value)} className={inputClass}>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className={actionClass} disabled={busy || !reopenStage} onClick={() => void act('Opportunity reopened.', () => sales.reopen(slug, o.id, { stageId: reopenStage }))}>{busy ? 'Saving…' : 'Reopen'}</button>
                <button type="button" className={secondaryClass} disabled={busy} onClick={close}>Cancel</button>
              </div>
            </>
          ) : null}
          {dialog.kind === 'archive' ? (
            <>
              <h2 id={`${uid}-dlg-title`} className="text-base font-semibold">Archive “{o.title}”?</h2>
              <p id={`${uid}-dlg-body`} className="mt-1 text-sm text-muted-foreground">It is hidden from the main list. Nothing is deleted, and you can restore it at any time.</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className={actionClass} disabled={busy} onClick={() => void act('Opportunity archived.', () => sales.archive(slug, o.id))}>{busy ? 'Archiving…' : 'Archive'}</button>
                <button type="button" autoFocus className={secondaryClass} disabled={busy} onClick={close}>Keep</button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Panel title="Details">
            <dl className="divide-y divide-border">
              <Row label="Customer">{customer ?? muted('None')}</Row>
              <Row label="Contact">{contact ?? muted('None')}</Row>
              {refData.pipelines.length > 1 ? <Row label="Pipeline">{refData.pipelines.find((p) => p.pipeline.id === o.pipelineId)?.pipeline.name ?? muted('Archived pipeline')}</Row> : null}
              <Row label="Stage">{stages.find((s) => s.id === o.stageId)?.name ?? muted('Archived stage')}</Row>
              <Row label="Amount"><span className="tabular-nums">{o.amount === null ? muted('Not set') : formatMoney(o.amount, o.currencyCode, locale)}</span> <span className="text-xs text-muted-foreground">{o.currencyCode}</span></Row>
              <Row label="Probability">{o.probability === null ? muted('Not set') : `${o.probability}%`}</Row>
              <Row label="Expected close">{o.expectedCloseDate ? formatDate(o.expectedCloseDate, locale) : muted('Not set')}</Row>
              <Row label="Owner">{ownerName(refData, o.ownerUserId) ?? muted('No owner')}</Row>
              {o.closedAt ? <Row label={o.status === 'WON' ? 'Won' : 'Lost'}>{formatWhen(o.closedAt, timeZone, locale)}</Row> : null}
              {o.lossReason ? <Row label="Loss reason"><span className="whitespace-pre-wrap">{o.lossReason}</span></Row> : null}
              <Row label="Added">{formatWhen(o.createdAt, timeZone, locale)}</Row>
            </dl>
          </Panel>
          <Panel title="Description">
            {o.description ? <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{o.description}</p> : <p className="text-sm text-muted-foreground">No description.</p>}
          </Panel>
        </div>
        <div className="space-y-5">
          {editable && isOpen && stages.length > 1 ? (
            <Panel title="Move to another stage">
              <label htmlFor={`${uid}-move`} className="mb-1 block text-xs font-medium text-muted-foreground">Stage</label>
              <select id={`${uid}-move`} value={moveTo || o.stageId} onChange={(e) => setMoveTo(e.target.value)} className={inputClass}>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" className={`${secondaryClass} mt-3 w-full`} disabled={busy || !moveTo || moveTo === o.stageId}
                onClick={() => void act(`Moved to ${stages.find((s) => s.id === moveTo)?.name ?? 'the new stage'}.`, () => sales.update(slug, o.id, { version: o.version, stageId: moveTo })).then(() => setMoveTo(''))}>
                Move
              </button>
            </Panel>
          ) : null}
          <Panel title="Outcome history">
            {history.state.status === 'loading' && history.previous === null ? <Skeleton rows={2} label="Loading history…" /> : null}
            {history.state.status === 'done' && history.state.outcome.kind !== 'ok' ? <Problem outcome={history.state.outcome} what="History" onRetry={history.reload} onSessionEnded={onSessionEnded} /> : null}
            {(() => {
              const rows = history.state.status === 'done' && history.state.outcome.kind === 'ok' ? history.state.outcome.data : history.previous?.kind === 'ok' ? history.previous.data : null;
              if (!rows) return null;
              if (rows.length === 0) return <p className="text-sm text-muted-foreground">Not won or lost yet.</p>;
              return (
                <ol className="space-y-4">
                  {rows.map((h) => (
                    <li key={h.id} className="text-sm">
                      <p className="font-medium">{h.status === 'WON' ? 'Won' : 'Lost'} <span className="font-normal text-muted-foreground">in {stages.find((s) => s.id === h.stageId)?.name ?? 'an archived stage'} · {formatMoney(h.amount, h.currencyCode, locale)}</span></p>
                      {h.lossReason ? <p className="mt-1 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">“{h.lossReason}”</p> : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {ownerName(refData, h.closedById) ?? 'Someone'} · <time dateTime={h.closedAt}>{formatWhen(h.closedAt, timeZone, locale)}</time>
                        {h.reopenedAt ? <> · reopened <time dateTime={h.reopenedAt}>{formatWhen(h.reopenedAt, timeZone, locale)}</time></> : null}
                      </p>
                    </li>
                  ))}
                </ol>
              );
            })()}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className="mb-4 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      <span aria-hidden="true">←</span> All opportunities
    </button>
  );
}
