import { Alert, AlertDescription, Button, Field, Input, SectionHeader } from '@business-os/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { ZonePage } from '../../shell/zone-page';
import type { AccountPageEnv } from './account-env';
import { Facts } from './parts';
import { useSave } from './save';

/**
 * Account › Profile (A3-A): your display name, which other members of your businesses see. Your email address is
 * shown but cannot be changed yet (D-A3-6). The change applies across every business you belong to.
 */
export function AccountProfilePage({ env }: { env: AccountPageEnv }) {
  const start = env.user.name ?? '';
  const [name, setName] = useState(start);
  const [saved, setSaved] = useState(false);
  const save = useSave(env.onSessionEnded);
  const dirty = name.trim() !== start;
  const { markDraft } = env;
  useEffect(() => markDraft('account-profile', dirty), [dirty, markDraft]);
  useEffect(() => () => markDraft('account-profile', false), [markDraft]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!dirty) return;
    await save.run(() => env.client.updateName(name), (user) => {
      markDraft('account-profile', false);
      setName(user.name ?? '');
      setSaved(true);
      env.onUserChanged();
    });
  }

  return (
    <ZonePage title="Profile" description="How you appear to the people you work with, in every business.">
      {saved ? <Alert tone="success"><AlertDescription>Your name was saved.</AlertDescription></Alert> : null}
      {save.error ? <Alert tone="danger"><AlertDescription>{save.error}</AlertDescription></Alert> : null}
      <form onSubmit={submit} noValidate className="space-y-4" aria-label="Change your name">
        <SectionHeader variant="ruled" as="h2" title={<span id="account-name">Name</span>} meta="Across every business" />
        <Field label="Your name" hint="Shown to other members of your businesses." error={save.fields.name}>
          {(c) => <Input {...c} required maxLength={200} autoComplete="name" value={name} onChange={(e) => { setSaved(false); setName(e.target.value); }} />}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.busy} disabled={!dirty}>Save name</Button>
          <Button variant="outline" disabled={!dirty || save.busy} onClick={() => { setName(start); save.reset(); }}>Revert</Button>
        </div>
      </form>
      <section aria-labelledby="account-email" className="space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="account-email">Email</span>} />
        <Facts items={[{ label: 'Email address', value: env.user.email, hint: env.user.emailVerified ? 'Verified. Used to sign in. It cannot be changed here yet.' : 'Not verified yet.' }]} />
      </section>
    </ZonePage>
  );
}
