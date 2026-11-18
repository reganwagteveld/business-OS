import { Alert, AlertDescription, Badge, Button, Field, Input, SectionHeader } from '@business-os/ui';
import { useState } from 'react';
import type { AccountSession } from '../../api/account';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import type { AccountPageEnv } from './account-env';
import { ConfirmDialog } from './confirm';
import { useSave } from './save';

const when = (iso: string, locale: string, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace('T', ' ');
  }
};
const clientLabel = (s: AccountSession) => (s.client === 'desktop' ? 'Pixa OS desktop app' : 'Web browser');

type Action = { kind: 'one'; session: AccountSession } | { kind: 'others' };

/**
 * Account › Signed-in devices (A3-A). Every browser and desktop app signed in to your account. Signing one out
 * ends it on its next request. "Sign out all other devices" needs your password. This device is signed out with
 * the account menu's Sign out, never from this list.
 */
export function AccountDevicesPage({ env }: { env: AccountPageEnv }) {
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSave(env.onSessionEnded);
  const load = useLoad(`account-sessions|${generation}`, (signal) => env.client.sessions(signal));
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const reload = () => setGeneration((g) => g + 1);
  const title = 'Signed-in devices';
  const description = 'Where your account is signed in. Sign out anything you do not recognise.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading your signed-in devices…' }} />;
  if (current.kind !== 'ok') return <ZonePage title={title} description={description}><Problem outcome={current} what="Your signed-in devices" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;

  const { sessions, truncated } = current.data;
  const others = sessions.filter((s) => !s.current);
  const close = () => { setAction(null); setPassword(''); save.reset(); };
  const confirm = () => {
    if (action?.kind === 'one') {
      return save.run(() => env.client.revokeSession(action.session.id), () => { setNotice('That device was signed out.'); close(); reload(); });
    }
    return save.run(() => env.client.revokeOtherSessions(password), ({ ended }) => {
      setNotice(ended === 1 ? 'One other device was signed out.' : `${ended} other devices were signed out.`);
      close();
      reload();
    });
  };

  return (
    <ZonePage title={title} description={description}
      primaryActions={others.length > 0 ? <Button variant="outline" onClick={() => { setNotice(null); setAction({ kind: 'others' }); }}>Sign out all other devices</Button> : undefined}>
      {notice ? <Alert tone="success"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      {truncated ? <Alert tone="warning"><AlertDescription>Only your 50 most recently active sessions are shown. “Sign out all other devices” ends every one of them.</AlertDescription></Alert> : null}
      <section aria-labelledby="devices-list" className="space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="devices-list">Sessions</span>} meta={`${sessions.length} signed in`} />
        <ul className="border-t border-line">
          {sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-body font-medium">
                  {clientLabel(s)}
                  {s.current ? <Badge tone="success">This device</Badge> : null}
                </p>
                <p className="text-small text-muted-foreground">
                  Signed in {when(s.createdAt, env.locale, env.timeZone)} · Last active {when(s.lastActiveAt, env.locale, env.timeZone)}
                </p>
              </div>
              {s.current
                ? <p className="text-small text-fg-subtle">Use Sign out in the account menu</p>
                : <Button variant="outline" size="sm" onClick={() => { setNotice(null); setAction({ kind: 'one', session: s }); }} aria-label={`Sign out ${clientLabel(s)}, last active ${when(s.lastActiveAt, env.locale, env.timeZone)}`}>Sign out</Button>}
            </li>
          ))}
        </ul>
      </section>
      <ConfirmDialog
        open={action?.kind === 'one'} title="Sign out this device?" confirmLabel="Sign out device" destructive busy={save.busy} error={save.error}
        description={action?.kind === 'one' ? <p>{clientLabel(action.session)}, last active {when(action.session.lastActiveAt, env.locale, env.timeZone)}, will be signed out the next time it does anything. Anyone using it will have to sign in again.</p> : null}
        onConfirm={confirm} onCancel={close}
      />
      <ConfirmDialog
        open={action?.kind === 'others'} title="Sign out all other devices?" confirmLabel="Sign out other devices" destructive busy={save.busy}
        error={save.error && !save.fields.password ? save.error : null}
        description={<p>Every browser and desktop app signed in to your account, except this one, will be signed out. Enter your password to confirm it is you.</p>}
        onConfirm={() => { if (password) void confirm(); }} onCancel={close}
      >
        <Field label="Your password" className="mt-4" error={save.fields.password}>
          {(c) => <Input {...c} type="password" autoComplete="current-password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </ConfirmDialog>
    </ZonePage>
  );
}
