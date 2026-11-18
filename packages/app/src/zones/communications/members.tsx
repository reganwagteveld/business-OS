import type { MailConnection } from '@business-os/contracts';
import { Alert, AlertTitle, Button, Field, Select } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { CommunicationsClient } from '../../api/communications';
import type { Member } from '../../api/customers';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { reasonFor } from './labels';

/**
 * Who may use a BUSINESS mailbox: READ (see it) or SEND (also send from it, once sending exists). The list is readable
 * by anyone who can see the mailbox; changing it needs communications:manage_connections, checked by the API.
 * Names come from the member list when the viewer may read it, otherwise a neutral label.
 */
export function MemberList({ client, slug, connection, team, canEdit, onSessionEnded }: {
  client: CommunicationsClient; slug: string; connection: MailConnection; team: Member[] | null; canEdit: boolean; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`mail-members|${slug}|${connection.id}`, (signal) => client.members(slug, connection.id, signal));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const inFlight = useRef(false);
  const members = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const nameOf = (userId: string) => team?.find((m) => m.userId === userId)?.name ?? 'A member of this business';

  const change = async (work: () => ReturnType<CommunicationsClient['setMember']>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await work();
      if (outcome.kind === 'ok') { setAdding(''); reload(); return; }
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      setError(reasonFor(outcome, 'This change'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const candidates = (team ?? []).filter((m) => !members?.some((x) => x.userId === m.userId));

  return (
    <section aria-label="Members" className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Members</h3>
      <p className="text-xs text-muted-foreground">Read lets someone see this mailbox. Send also lets them send from it once sending is built. Neither gives access to anything today, because no mail is synced.</p>
      {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
      {state.status === 'loading' ? <div role="status" aria-busy="true" className="h-10 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"><span className="sr-only">Loading members…</span></div> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Members" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {members && members.length === 0 ? <p className="text-sm text-muted-foreground">No members yet. Only people who manage mailboxes can see it.</p> : null}
      {members && members.length > 0 ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="[overflow-wrap:anywhere]">{nameOf(m.userId)}</span>
              {canEdit ? (
                <span className="flex items-center gap-2">
                  <Select aria-label={`Access for ${nameOf(m.userId)}`} className="h-8 w-28" disabled={busy} value={m.access}
                    onChange={(e) => void change(() => client.setMember(slug, connection.id, m.userId, e.target.value))}>
                    <option value="READ">Read</option><option value="SEND">Send</option>
                  </Select>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(() => client.removeMember(slug, connection.id, m.userId))} aria-label={`Remove ${nameOf(m.userId)}`}>Remove</Button>
                </span>
              ) : <span className="text-muted-foreground">{m.access === 'SEND' ? 'Send' : 'Read'}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit && team ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a member" className="min-w-48 flex-1">{(f) => (
            <Select {...f} disabled={busy || candidates.length === 0} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">{candidates.length === 0 ? 'Everyone is already a member' : 'Choose a person'}</option>
              {candidates.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Unnamed member'}</option>)}
            </Select>
          )}</Field>
          <Button variant="outline" disabled={busy || !adding} onClick={() => void change(() => client.setMember(slug, connection.id, adding, 'READ'))}>Add with Read</Button>
        </div>
      ) : null}
    </section>
  );
}
