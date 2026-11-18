import type { MailConnection } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, Field, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { CommunicationsClient, MailProviderInfo } from '../../api/communications';
import type { Member } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { errorText, PROVIDER_NAME, reasonFor, sharingLabel, statusOf, SYNC_NOTICE } from './labels';
import { MemberList } from './members';

export interface MailboxPermissions { canConnect: boolean; canManage: boolean }

/** Connect buttons: one per provider this deployment has set up. An unset provider says so instead of failing. */
export function ConnectButtons({ providers, busy, onConnect }: { providers: MailProviderInfo[]; busy: boolean; onConnect: (provider: 'GOOGLE' | 'MICROSOFT') => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((p) => (
        <Button key={p.provider} variant="outline" disabled={busy || !p.configured} onClick={() => onConnect(p.provider)}
          title={p.configured ? undefined : 'Not switched on for this deployment yet'}>
          Connect {PROVIDER_NAME[p.provider]} mailbox{p.configured ? '' : ' (not available)'}
        </Button>
      ))}
    </div>
  );
}

/** Can this person change this mailbox's settings? Presentation only: the API decides, and answers 404 for what you cannot see. */
function canChange(c: MailConnection, perms: MailboxPermissions): boolean {
  if (c.status === 'DISCONNECTED') return false;
  return c.isOwner ? perms.canConnect : perms.canManage;
}

export function Mailboxes({ client, slug, perms, providers, team, locale, onConnect, onChanged, onSessionEnded }: {
  client: CommunicationsClient; slug: string; perms: MailboxPermissions; providers: MailProviderInfo[] | null; team: Member[] | null; locale: string;
  onConnect: (input: { provider: 'GOOGLE' | 'MICROSOFT'; connectionId?: string }) => Promise<string | null>;
  onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const { state, reload } = useLoad(`mail-connections|${slug}|${showAll}`, (signal) => client.connections(slug, showAll, signal));
  const rows = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const selected = rows?.find((r) => r.id === open) ?? null;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });

  const connect = async (provider: 'GOOGLE' | 'MICROSOFT') => {
    setConnecting(true);
    setConnectError(null);
    const error = await onConnect({ provider });
    if (error) setConnectError(error);
    setConnecting(false);
  };

  return (
    <div className="space-y-6">
      <Alert tone="info"><AlertTitle>Mail is not available yet</AlertTitle><AlertDescription>{SYNC_NOTICE}</AlertDescription></Alert>
      {perms.canConnect && providers ? (
        <section aria-labelledby="connect-heading" className="space-y-2">
          <h2 id="connect-heading" className="text-sm font-semibold">Connect your own mailbox</h2>
          <p className="text-sm text-muted-foreground">Signs you in at the provider. Connections are still being tested with approved accounts only.</p>
          {providers.every((p) => !p.configured) ? <Alert tone="warning"><AlertTitle>Connecting mailboxes is not switched on for this deployment yet</AlertTitle></Alert> : null}
          <ConnectButtons providers={providers} busy={connecting} onConnect={(p) => void connect(p)} />
          {connectError ? <Alert tone="danger"><AlertTitle>{connectError}</AlertTitle></Alert> : null}
        </section>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show disconnected mailboxes
      </label>
      {state.status === 'loading' ? <div role="status" aria-busy="true" className="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading mailboxes…</span></div> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Mailboxes" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {rows && rows.length === 0 ? (
        <EmptyState title="No mailboxes connected"
          description={perms.canConnect ? 'Connect your mailbox above. Business mailboxes are set up on the Business mailboxes tab.' : 'Mailboxes connected by your team that you may see will appear here.'} />
      ) : null}
      {rows && rows.length > 0 ? (
        <Table aria-label="Mailboxes">
          <TableHeader>
            <TableRow>
              <TableHead>Mailbox</TableHead><TableHead className="hidden sm:table-cell">Type</TableHead><TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Access</TableHead><TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => {
              const s = statusOf(c);
              return (
                <TableRow key={c.id}>
                  <TableCell className="[overflow-wrap:anywhere]">
                    <div className="font-medium">{c.mailboxAddress}</div>
                    <div className="text-xs text-muted-foreground">{PROVIDER_NAME[c.provider]}{c.displayName ? ` · ${c.displayName}` : ''} · connected {fmt(c.connectedAt)}</div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell"><Badge tone={c.kind === 'BUSINESS' ? 'brand' : 'neutral'}>{c.kind === 'BUSINESS' ? 'Business' : 'Personal'}</Badge></TableCell>
                  <TableCell><Badge tone={s.tone}>{s.label}</Badge></TableCell>
                  <TableCell className="hidden md:table-cell text-sm">{sharingLabel(c)}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => setOpen(c.id)} aria-label={`Manage ${c.mailboxAddress}`}>Manage</Button></TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
      {selected ? (
        <ManageDialog key={selected.id} client={client} slug={slug} connection={selected} editable={canChange(selected, perms)} perms={perms} team={team}
          onClose={() => setOpen(null)} onConnect={onConnect} onSessionEnded={onSessionEnded}
          onChanged={(message) => { reload(); onChanged(message); }} />
      ) : null}
    </div>
  );
}

function ManageDialog({ client, slug, connection: c, editable, perms, team, onClose, onConnect, onChanged, onSessionEnded }: {
  client: CommunicationsClient; slug: string; connection: MailConnection; editable: boolean; perms: MailboxPermissions; team: Member[] | null;
  onClose: () => void; onConnect: (input: { provider: 'GOOGLE' | 'MICROSOFT'; connectionId?: string }) => Promise<string | null>;
  onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const s = statusOf(c);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const inFlight = useRef(false);

  const run = async (work: () => Promise<Outcome<unknown> | string | null>, success: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (typeof result === 'string') return setError(result);
      if (result && result.kind === 'unauthenticated') return onSessionEnded();
      if (result && result.kind !== 'ok') return setError(reasonFor(result, 'This change'));
      onChanged(success);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const setSharing = (sharing: 'OWNER_ONLY' | 'BUSINESS') => run(() => client.update(slug, c.id, { sharing, version: c.version }), sharing === 'BUSINESS' ? 'Mailbox shared with the business.' : 'Mailbox is private to its owner.');
  const setSync = (syncEnabled: boolean) => run(() => client.update(slug, c.id, { syncEnabled, version: c.version }), syncEnabled ? 'Sync setting turned on.' : 'Sync setting turned off.');
  const reconnect = () => run(() => onConnect({ provider: c.provider, connectionId: c.id }), 'Opening the provider sign-in…');
  const disconnect = () => run(async () => {
    const outcome = await client.disconnect(slug, c.id);
    if (outcome.kind === 'ok') { setConfirming(false); onClose(); }
    return outcome;
  }, `${c.mailboxAddress} was disconnected.`);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogTitle>{c.mailboxAddress}</DialogTitle>
        <DialogDescription>{PROVIDER_NAME[c.provider]} · {c.kind === 'BUSINESS' ? 'Business mailbox' : 'Personal mailbox'}</DialogDescription>
        <div className="space-y-4">
          {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Status</dt><dd><Badge tone={s.tone}>{s.label}</Badge> <span className="ml-1">{s.help}</span></dd>
            <dt className="text-muted-foreground">Access</dt><dd>{sharingLabel(c)}</dd>
            <dt className="text-muted-foreground">Sync</dt>
            <dd>Not available yet{c.lastSyncedAt ? `. Last synced ${new Date(c.lastSyncedAt).toLocaleString()}` : ''}. Allowed when it starts: {c.syncEnabled ? 'yes' : 'no'}.</dd>
            {c.lastErrorCode ? (<><dt className="text-muted-foreground">Last problem</dt><dd>{errorText(c.lastErrorCode)}</dd></>) : null}
          </dl>
          {c.kind === 'BUSINESS' ? <MemberList client={client} slug={slug} connection={c} team={team} canEdit={perms.canManage && c.status !== 'DISCONNECTED'} onSessionEnded={onSessionEnded} /> : null}
          {editable ? (
            <div className="space-y-3 border-t border-border pt-4">
              {c.kind === 'PERSONAL' && c.isOwner ? (
                <Field label="Who can see this mailbox" hint="Sharing needs the business retention period to be set first. Nothing is shared until mail sync exists.">{(f) => (
                  <Select {...f} disabled={busy} value={c.sharing} onChange={(e) => void setSharing(e.target.value as 'OWNER_ONLY' | 'BUSINESS')}>
                    <option value="OWNER_ONLY">Only me</option><option value="BUSINESS">Everyone in the business</option>
                  </Select>
                )}</Field>
              ) : null}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={busy} checked={c.syncEnabled} onChange={(e) => void setSync(e.target.checked)} /> Allow sync when it becomes available
              </label>
              {(c.kind === 'PERSONAL' ? c.isOwner : perms.canManage) ? (
                <Button variant="outline" disabled={busy} onClick={() => void reconnect()}>{c.status === 'NEEDS_REAUTH' ? 'Reconnect mailbox' : 'Reconnect (renew sign-in)'}</Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {editable ? <Button variant="destructive" disabled={busy} onClick={() => setConfirming(true)}>Disconnect</Button> : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>Close</Button>
        </DialogFooter>
        {confirming ? (
          <Dialog open onOpenChange={(open) => { if (!open && !busy) setConfirming(false); }}>
            <DialogContent>
              <DialogTitle>Disconnect {c.mailboxAddress}?</DialogTitle>
              <DialogDescription>
                Pixa OS deletes its stored sign-in for this mailbox. {PROVIDER_NAME[c.provider]} keeps the access you granted until you remove Pixa OS in your {PROVIDER_NAME[c.provider]} account settings. Mail already recorded in Pixa OS is not deleted.
              </DialogDescription>
              <DialogFooter>
                <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
                <Button variant="destructive" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
