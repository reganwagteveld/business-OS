import { Alert, AlertDescription, Button, Field, Input, SectionHeader } from '@business-os/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { ZonePage } from '../../shell/zone-page';
import type { AccountPageEnv } from './account-env';
import { useSave } from './save';

const EMPTY = { currentPassword: '', newPassword: '', confirm: '' };

/**
 * Account › Password (A3-A). Needs your current password, checked on the server. On success every other device
 * signed in to your account is signed out; this one stays signed in. Passwords are never kept after the request.
 */
export function AccountPasswordPage({ env }: { env: AccountPageEnv }) {
  const [v, setV] = useState(EMPTY);
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const save = useSave(env.onSessionEnded);
  const dirty = v.currentPassword !== '' || v.newPassword !== '' || v.confirm !== '';
  const { markDraft } = env;
  useEffect(() => markDraft('account-password', dirty), [dirty, markDraft]);
  useEffect(() => () => markDraft('account-password', false), [markDraft]);
  const set = (change: Partial<typeof EMPTY>) => { setDone(null); setMismatch(false); setV((x) => ({ ...x, ...change })); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (v.newPassword !== v.confirm) {
      setMismatch(true);
      return;
    }
    await save.run(() => env.client.changePassword({ currentPassword: v.currentPassword, newPassword: v.newPassword }), ({ otherSessionsEnded }) => {
      markDraft('account-password', false);
      setV(EMPTY);
      setDone(otherSessionsEnded === 0
        ? 'Your password was changed.'
        : `Your password was changed, and ${otherSessionsEnded === 1 ? 'one other device was' : `${otherSessionsEnded} other devices were`} signed out.`);
    });
  }

  return (
    <ZonePage title="Password" description="Change the password you sign in with.">
      {done ? <Alert tone="success"><AlertDescription>{done}</AlertDescription></Alert> : null}
      {save.error && Object.keys(save.fields).length === 0 ? <Alert tone="danger"><AlertDescription>{save.error}</AlertDescription></Alert> : null}
      <form onSubmit={submit} noValidate className="max-w-md space-y-4" aria-label="Change password">
        <SectionHeader variant="ruled" as="h2" title="Change password" meta="Signs out your other devices" />
        <Field label="Current password" error={save.fields.currentPassword}>
          {(c) => <Input {...c} type="password" required autoComplete="current-password" maxLength={128} value={v.currentPassword} onChange={(e) => set({ currentPassword: e.target.value })} />}
        </Field>
        <Field label="New password" hint="At least 12 characters." error={save.fields.newPassword}>
          {(c) => <Input {...c} type="password" required autoComplete="new-password" minLength={12} maxLength={128} value={v.newPassword} onChange={(e) => set({ newPassword: e.target.value })} />}
        </Field>
        <Field label="Confirm new password" error={mismatch ? 'The two new passwords do not match.' : undefined}>
          {(c) => <Input {...c} type="password" required autoComplete="new-password" maxLength={128} value={v.confirm} onChange={(e) => set({ confirm: e.target.value })} />}
        </Field>
        <p className="text-small text-muted-foreground">Every other browser and desktop app signed in to your account will be signed out. Forgotten your password? Sign out and use “Forgot password” on the sign-in screen.</p>
        <Button type="submit" loading={save.busy} disabled={!v.currentPassword || !v.newPassword || !v.confirm}>Change password</Button>
      </form>
    </ZonePage>
  );
}
