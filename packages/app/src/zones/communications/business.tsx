import { MAIL_BUSINESS_ATTESTATION_V1, type MailBusinessAddress, type MailBusinessDomain } from '@business-os/contracts';
import { Alert, AlertTitle, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, Field, Input } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { CommunicationsClient, MailProviderInfo } from '../../api/communications';
import type { Outcome } from '../../api/tenancy';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ConnectButtons } from './mailboxes';
import { reasonFor } from './labels';

/**
 * Business mailboxes (docs/communications-c2.md §16): the domains the business proves it controls, the addresses it
 * designates, and connecting a designated address. All of it needs communications:manage_connections, which the API checks.
 * A consumer address (gmail.com, outlook.com) can be designated only with an owner's confirmation.
 */
export function BusinessMailboxes({ client, slug, isOwner, providers, onConnect, onChanged, onSessionEnded }: {
  client: CommunicationsClient; slug: string; isOwner: boolean; providers: MailProviderInfo[] | null;
  onConnect: (input: { provider: 'GOOGLE' | 'MICROSOFT'; businessAddressId: string }) => Promise<string | null>;
  onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const domains = useLoad(`mail-domains|${slug}`, (signal) => client.domains(slug, signal));
  const addresses = useLoad(`mail-addresses|${slug}`, (signal) => client.addresses(slug, signal));
  const [newDomain, setNewDomain] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [needsAttestation, setNeedsAttestation] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [record, setRecord] = useState<MailBusinessDomain | null>(null);
  const ok = <T,>(l: { state: { status: string; outcome?: Outcome<T> } }) => (l.state.status === 'done' && l.state.outcome?.kind === 'ok' ? l.state.outcome.data : null);
  const domainRows = ok<MailBusinessDomain[]>(domains);
  const addressRows = ok<MailBusinessAddress[]>(addresses);

  const act = async <T,>(work: () => Promise<Outcome<T>>, success: string, after?: (data: T) => void) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await work();
      if (outcome.kind === 'ok') { after?.(outcome.data); domains.reload(); addresses.reload(); onChanged(success); return; }
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      if (outcome.kind === 'conflict' && outcome.code === 'consumer_domain') setNeedsAttestation(true);
      setError(reasonFor(outcome, 'This change'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">A business mailbox (such as info@ or sales@) belongs to the business, not to one person. Prove the business controls its domain, or have an owner confirm a consumer address, then connect it. Connected mailboxes are recorded but no mail is synced yet.</p>
      {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}

      <section aria-labelledby="domains-heading" className="space-y-3">
        <h2 id="domains-heading" className="text-base font-semibold">Verified domains</h2>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => client.addDomain(slug, { domain: newDomain }), 'Domain added. Add the DNS record, then verify.', (d) => { setRecord(d); setNewDomain(''); }); }}>
          <Field label="Add a domain" className="min-w-56 flex-1">{(f) => <Input {...f} value={newDomain} placeholder="example.com" onChange={(e) => setNewDomain(e.target.value)} />}</Field>
          <Button type="submit" variant="outline" disabled={busy || !newDomain.trim()}>Add domain</Button>
        </form>
        {domains.state.status === 'done' && domains.state.outcome.kind !== 'ok' ? <Problem outcome={domains.state.outcome} what="Domains" onRetry={domains.reload} onSessionEnded={onSessionEnded} /> : null}
        {domainRows && domainRows.length === 0 ? <EmptyState title="No domains yet" description="Add your domain to prove the business controls it." /> : null}
        {domainRows && domainRows.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {domainRows.filter((d) => d.status !== 'REMOVED').map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium [overflow-wrap:anywhere]">{d.domain}</span>{' '}
                  <Badge tone={d.status === 'VERIFIED' ? 'success' : 'warning'}>{d.status === 'VERIFIED' ? 'Verified' : 'Waiting for DNS'}</Badge>
                  {d.status === 'PENDING' ? <span className="mt-1 block text-xs text-muted-foreground">TXT record name: <code>{d.dnsRecord.name}</code></span> : null}
                </span>
                <span className="flex gap-2">
                  {d.status === 'PENDING' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => client.verifyDomain(slug, d.id, d.version), `${d.domain} verified.`)} aria-label={`Verify ${d.domain}`}>Verify</Button> : null}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => client.removeDomain(slug, d.id, d.version), `${d.domain} removed.`)} aria-label={`Remove ${d.domain}`}>Remove</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="addresses-heading" className="space-y-3">
        <h2 id="addresses-heading" className="text-base font-semibold">Business addresses</h2>
        <form className="space-y-2" onSubmit={(e) => {
          e.preventDefault();
          const attestation = needsAttestation && accepted ? { statement: 'v1' as const, accepted: true as const } : undefined;
          void act(() => client.addAddress(slug, { address: newAddress, ...(attestation ? { attestation } : {}) }), 'Business address added.', () => { setNewAddress(''); setNeedsAttestation(false); setAccepted(false); });
        }}>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Add a business address" className="min-w-56 flex-1">{(f) => <Input {...f} type="email" value={newAddress} placeholder="info@example.com" onChange={(e) => { setNewAddress(e.target.value); setNeedsAttestation(false); setAccepted(false); }} />}</Field>
            <Button type="submit" variant="outline" disabled={busy || !newAddress.trim() || (needsAttestation && !accepted)}>Add address</Button>
          </div>
          {needsAttestation ? (
            isOwner ? (
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /><span>{MAIL_BUSINESS_ATTESTATION_V1}</span></label>
            ) : <Alert tone="warning"><AlertTitle>Only an owner can confirm a consumer address for business use.</AlertTitle></Alert>
          ) : null}
        </form>
        {addresses.state.status === 'done' && addresses.state.outcome.kind !== 'ok' ? <Problem outcome={addresses.state.outcome} what="Addresses" onRetry={addresses.reload} onSessionEnded={onSessionEnded} /> : null}
        {addressRows && addressRows.length === 0 ? <EmptyState title="No business addresses yet" description="Add an address on a verified domain, then connect it." /> : null}
        {addressRows && addressRows.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {addressRows.filter((a) => !a.removedAt).map((a) => (
              <li key={a.id} className="space-y-2 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-medium [overflow-wrap:anywhere]">{a.address}</span>{' '}
                    <Badge tone="neutral">{a.basis === 'VERIFIED_DOMAIN' ? 'Verified domain' : 'Owner confirmed'}</Badge>{' '}
                    <Badge tone={a.connectionId ? 'success' : 'warning'}>{a.connectionId ? 'Connected' : 'Not connected'}</Badge></span>
                  <Button size="sm" variant="outline" disabled={busy || Boolean(a.connectionId)} title={a.connectionId ? 'Disconnect the mailbox first' : undefined}
                    onClick={() => void act(() => client.removeAddress(slug, a.id, a.version), `${a.address} removed.`)} aria-label={`Remove ${a.address}`}>Remove</Button>
                </div>
                {!a.connectionId && providers ? <ConnectButtons providers={providers} busy={busy} onConnect={(provider) => void (async () => { setError(await onConnect({ provider, businessAddressId: a.id })); })()} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {record ? (
        <Dialog open onOpenChange={(open) => { if (!open) setRecord(null); }}>
          <DialogContent>
            <DialogTitle>Add this DNS record</DialogTitle>
            <DialogDescription>Add a TXT record at your DNS provider, then choose Verify. The value is shown only now: Pixa OS keeps a hash and cannot show it again.</DialogDescription>
            <dl className="space-y-2 text-sm">
              <div><dt className="text-muted-foreground">Name</dt><dd><code className="[overflow-wrap:anywhere]">{record.dnsRecord.name}</code></dd></div>
              <div><dt className="text-muted-foreground">Value</dt><dd><code className="[overflow-wrap:anywhere]">{record.dnsRecord.value ?? ''}</code></dd></div>
            </dl>
            <DialogFooter><Button onClick={() => setRecord(null)}>Done</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
