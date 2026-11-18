import { Alert, AlertTitle, Button, Field, Input } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { CommunicationsClient } from '../../api/communications';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { reasonFor } from './labels';

/**
 * The business's ordinary-communications retention period (D-C2-9, E1 D-E1-3). There is no default: it must be set before
 * business mailbox sync or sharing a personal mailbox. A shorter period takes effect 30 days after the change.
 * Changing it needs communications:manage_connections; everyone with Communications access can read it.
 */
export function Retention({ client, slug, canManage, onChanged, onSessionEnded }: {
  client: CommunicationsClient; slug: string; canManage: boolean; onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`mail-retention|${slug}`, (signal) => client.retention(slug, signal));
  const [days, setDays] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const retention = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !retention) return;
    const value = Number(days);
    if (!Number.isInteger(value) || value < 1 || value > 36525) return setError('Enter a whole number of days between 1 and 36525.');
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await client.setRetention(slug, { ordinaryRetentionDays: value, version: retention.version });
      if (outcome.kind === 'ok') { setDays(''); reload(); onChanged('Retention period saved.'); return; }
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      setError(reasonFor(outcome, 'The retention period'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl space-y-4">
      <p className="text-sm text-muted-foreground">How long ordinary business email is kept once mail sync exists. Records the law requires you to keep are handled separately, and no period is assumed for you.</p>
      {state.status === 'loading' ? <div role="status" aria-busy="true" className="h-16 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading retention…</span></div> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Retention" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {retention ? (
        <>
          {retention.ordinaryRetentionDays === null ? (
            <Alert tone="warning"><AlertTitle>Not set</AlertTitle><p className="mt-1 text-sm">Required before business mailboxes can sync and before a personal mailbox can be shared.</p></Alert>
          ) : (
            <p className="text-sm">Ordinary email is kept for <strong>{retention.ordinaryRetentionDaysInForce ?? retention.ordinaryRetentionDays} days</strong>.
              {retention.pendingReduction ? ` A shorter period of ${retention.ordinaryRetentionDays} days applies from ${new Date(retention.pendingReduction.effectiveAt).toLocaleDateString()}.` : ''}</p>
          )}
          {canManage ? (
            <form onSubmit={(e) => void save(e)} noValidate className="space-y-3">
              {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
              <Field label="Retention period (days)" hint="A shorter period only takes effect after 30 days.">{(f) => <Input {...f} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
              <Button type="submit" loading={busy} disabled={!days.trim()}>Save retention period</Button>
            </form>
          ) : <p className="text-sm text-muted-foreground">Only owners and admins can change this.</p>}
        </>
      ) : null}
    </div>
  );
}
