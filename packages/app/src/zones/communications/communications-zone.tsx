import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommunicationsClient } from '../../api/communications';
import type { CustomersClient } from '../../api/customers';
import type { BusinessContext } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { BusinessMailboxes } from './business';
import { RETURN_RESULTS, reasonFor, safeConsentUrl } from './labels';
import { Mailboxes } from './mailboxes';
import { Retention } from './retention';

type Tab = 'mailboxes' | 'business' | 'retention';

/**
 * The Communications Zone (C2-UI-C): connect and manage mailboxes. It does not read, list or send mail, because the
 * sync and send backend does not exist yet (docs/communications-c2-ui.md); the screens say so and show nothing simulated.
 * Mount with `key={slug}` so a business switch discards all state. Authorisation is the API's: the permission checks here
 * only decide what to show.
 */
export function CommunicationsZone({ client, customers, context, userLabel, openConsent, returnResult, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: CommunicationsClient;
  /** Only used to name members; absent without members:read. */
  customers?: CustomersClient;
  context: BusinessContext; userLabel: string;
  /** Opens the provider consent in the browser where the person is signed in. Defaults to this window. */
  openConsent?: (url: string) => void;
  /** The code the OAuth return page handed back (`?mailbox=`), if any. */
  returnResult?: string;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, locale } = context.business;
  const can = (p: string) => context.membership.permissions.includes(p);
  const perms = { canConnect: can('communications:connect'), canManage: can('communications:manage_connections') };
  const [tab, setTab] = useState<Tab>('mailboxes');
  const result = returnResult ? RETURN_RESULTS[returnResult] ?? RETURN_RESULTS.error : null;
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(result ?? null);
  const content = useRef<HTMLDivElement>(null);

  const providers = useLoad(`mail-providers|${slug}|${perms.canConnect}`, async (signal) => (perms.canConnect ? client.providers(slug, signal) : { kind: 'forbidden' as const }));
  const providerList = providers.state.status === 'done' && providers.state.outcome.kind === 'ok' ? providers.state.outcome.data : null;
  const canListMembers = can('members:read') && Boolean(customers);
  const team = useLoad(`mail-team|${slug}|${canListMembers}`, async (signal) => (canListMembers && customers ? customers.members(slug, signal) : { kind: 'forbidden' as const }));
  const teamList = team.state.status === 'done' && team.state.outcome.kind === 'ok' ? team.state.outcome.data : null;

  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [tab]);

  const connect = useCallback(async (input: { provider: 'GOOGLE' | 'MICROSOFT'; connectionId?: string; businessAddressId?: string }): Promise<string | null> => {
    const outcome = await client.authorize(slug, input);
    if (outcome.kind === 'unauthenticated') { onSessionEnded(); return null; }
    if (outcome.kind !== 'ok') return reasonFor(outcome, 'Connecting');
    const url = safeConsentUrl(outcome.data.authorizationUrl);
    if (!url) return 'The provider address was not recognised, so nothing was opened.';
    (openConsent ?? ((u: string) => window.location.assign(u)))(url);
    return null;
  }, [client, slug, openConsent, onSessionEnded]);

  const tabs = [
    { id: 'mailboxes', label: 'Mailboxes' },
    ...(perms.canManage ? [{ id: 'business', label: 'Business mailboxes' }] : []),
    { id: 'retention', label: 'Retention' },
  ];
  const changed = (text: string) => setNotice({ tone: 'success', text });
  const title = tab === 'business' ? 'Business mailboxes' : tab === 'retention' ? 'Retention' : 'Mailboxes';

  return (
    <ZoneFrame zone="Communications" business={name} user={userLabel} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div ref={content}>
        <ZonePage title={title} eyebrow="Communications" description="Connect and manage the mailboxes this business uses." tabs={tabs} currentTab={tab}
          onTab={(id) => { setNotice(null); setTab(id as Tab); }}>
          {notice ? <p role={notice.tone === 'danger' ? 'alert' : 'status'} className="rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice.text}</p> : null}
          {tab === 'mailboxes' ? (
            <Mailboxes client={client} slug={slug} perms={perms} providers={providerList} team={teamList} locale={locale} onConnect={connect} onChanged={changed} onSessionEnded={onSessionEnded} />
          ) : null}
          {tab === 'business' && perms.canManage ? (
            <BusinessMailboxes client={client} slug={slug} isOwner={context.membership.role === 'OWNER'} providers={providerList}
              onConnect={connect} onChanged={changed} onSessionEnded={onSessionEnded} />
          ) : null}
          {tab === 'retention' ? <Retention client={client} slug={slug} canManage={perms.canManage} onChanged={changed} onSessionEnded={onSessionEnded} /> : null}
        </ZonePage>
      </div>
    </ZoneFrame>
  );
}
