import type { Customer } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { BusinessContext } from '../../api/tenancy';
import { actionClass, secondaryClass } from '../../shell/frame';
import { ZoneFrame } from '../zone-frame';
import { CustomerDetail } from './customer-detail';
import { CustomerForm } from './customer-form';
import { Directory, type DirectoryQuery } from './directory';

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; customer: Customer };

/**
 * The Customer Zone: directory, create/edit form and customer workspace. Mount it with `key={slug}`
 * so switching business discards every bit of this state; nothing here is persisted or cached
 * outside the component, and every request names the business only through the URL.
 */
export function CustomerZone({ client, context, userLabel, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: CustomersClient; context: BusinessContext; userLabel: string; onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, timeZone, locale } = context.business;
  const canWrite = context.membership.permissions.includes('customers:write');
  const canLogActivity = context.membership.permissions.includes('activity:write');
  const [view, setView] = useState<View>({ name: 'list' });
  const [query, setQuery] = useState<DirectoryQuery>({ q: '', status: 'active' });
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const content = useRef<HTMLDivElement>(null);

  // Unsaved changes are never dropped silently: in-app moves ask first, and so does closing the window.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = useCallback((action: () => void) => (dirty ? setPending(() => action) : action()), [dirty]);
  const go = (next: View, message: string | null = null) => {
    setDirty(false);
    setNotice(message);
    setView(next);
  };

  // Move focus to the new screen's heading so keyboard and screen-reader users land on the change.
  const viewKey = view.name === 'detail' ? `detail:${view.id}` : view.name === 'edit' ? `edit:${view.customer.id}` : view.name;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  return (
    <ZoneFrame zone="Customers" business={name} user={userLabel} onHome={() => leave(onHome)} onSwitch={() => leave(onSwitch)} onSignOut={() => leave(onSignOut)}>
      <div ref={content}>
        {notice ? <p role="status" className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}
        {view.name === 'list' ? (
          <Directory
            client={client} slug={slug} locale={locale} query={query} onQuery={setQuery} canWrite={canWrite}
            onOpen={(id) => go({ name: 'detail', id })} onAdd={() => go({ name: 'new' })} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'detail' ? (
          <CustomerDetail
            client={client} slug={slug} id={view.id} locale={locale} timeZone={timeZone} canWrite={canWrite} canLogActivity={canLogActivity}
            onBack={() => go({ name: 'list' })} onEdit={(customer) => go({ name: 'edit', customer })} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'new' || view.name === 'edit' ? (
          <CustomerForm
            key={view.name === 'edit' ? view.customer.id : 'new'}
            client={client} slug={slug} locale={locale} customer={view.name === 'edit' ? view.customer : undefined}
            onDirtyChange={setDirty} onSessionEnded={onSessionEnded}
            onCancel={() => leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.customer.id } : { name: 'list' }))}
            onSaved={(saved) => go({ name: 'detail', id: saved.id }, view.name === 'edit' ? 'Changes saved.' : `${saved.displayName} was added.`)}
          />
        ) : null}
      </div>
      {pending ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-background/80 px-5 backdrop-blur-sm">
          <div role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-body" className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg">
            <h2 id="discard-title" className="text-lg font-semibold tracking-tight">Discard unsaved changes?</h2>
            <p id="discard-body" className="mt-2 text-sm text-muted-foreground">You have changes that have not been saved. If you leave now, they will be lost.</p>
            <div className="mt-6 flex gap-3">
              <button type="button" autoFocus className={actionClass} onClick={() => setPending(null)}>Keep editing</button>
              <button type="button" className={secondaryClass} onClick={() => { const run = pending; setPending(null); setDirty(false); run(); }}>Discard changes</button>
            </div>
          </div>
        </div>
      ) : null}
    </ZoneFrame>
  );
}
