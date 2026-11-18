import { Alert, AlertDescription, Button, Field, SectionHeader, Select } from '@business-os/ui';
import { useState } from 'react';
import type { Outcome } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import type { SettingsPageEnv } from './business-profile';
import { ConfirmDialog } from './confirm';
import { useSave } from './save';
import { ROLE_LABEL } from './team-rules';

type Flow = 'transfer' | 'step-down' | 'leave';

/**
 * Business › Ownership and leaving: the actions that change who runs the business, kept apart from the
 * forms. Each needs the business name typed (confirming intent, not proof of identity). A business must
 * always keep an active owner: the server refuses anything that would leave it with none (409 last_owner).
 */
export function OwnershipPage({ env }: { env: SettingsPageEnv }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [target, setTarget] = useState('');
  const [alsoStepDown, setAlsoStepDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSave(env.onSessionEnded);
  const isOwner = env.me.role === 'OWNER';
  const load = useLoad(`settings-owners|${env.slug}`, (signal) => env.client.members(env.slug, signal));
  const title = 'Ownership and leaving';
  const description = 'Who owns this business, and how you can hand it over or leave it.';
  const canSeeMembers = env.me.permissions.includes('members:read');
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  if (canSeeMembers && !current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading owners…' }} />;
  if (canSeeMembers && current && current.kind !== 'ok') return <ZonePage title={title} description={description}><Problem outcome={current} what="Owners" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;

  const members = current && current.kind === 'ok' ? current.data : [];
  const owners = members.filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE');
  const candidates = members.filter((m) => m.role !== 'OWNER' && m.status === 'ACTIVE');
  const name = (m: { name: string | null; email?: string | null }) => m.name || m.email || 'Unnamed member';
  const chosen = candidates.find((m) => m.id === target);
  const close = () => { setFlow(null); save.reset(); };
  const run = (call: () => Promise<Outcome<unknown>>, done: string, left = false) => save.run(call, () => {
    setNotice(done); close(); setTarget(''); setAlsoStepDown(false);
    if (left) env.onLeft(); else { load.reload(); env.onSaved(); }
  });
  const confirm = () => {
    if (flow === 'transfer' && chosen) return run(() => env.client.transferOwnership(env.slug, chosen.id, alsoStepDown), alsoStepDown ? `${name(chosen)} is now an owner, and you are now an Admin.` : `${name(chosen)} is now an owner.`);
    if (flow === 'step-down') return run(() => env.client.stepDown(env.slug), 'You are now an Admin.');
    if (flow === 'leave') return run(() => env.client.leave(env.slug), 'You left the business.', true);
  };

  return (
    <ZonePage title={title} description={description}>
      {notice ? <Alert tone="success"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <section aria-labelledby="own-now" className="space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="own-now">Today</span>} />
        <p className="text-body">Your role is <strong>{ROLE_LABEL[env.me.role]}</strong>.{canSeeMembers ? <> This business has {owners.length} active {owners.length === 1 ? 'owner' : 'owners'}{owners.length > 0 ? `: ${owners.map(name).join(', ')}` : ''}.</> : null}</p>
      </section>
      {isOwner ? (
        <section aria-labelledby="own-transfer" className="space-y-3">
          <SectionHeader variant="ruled" as="h2" title={<span id="own-transfer">Make someone an owner</span>} />
          <p className="text-small text-muted-foreground">Owners can do everything, including managing other owners. Choose an active member. You can also step down to Admin as part of the hand-over.</p>
          {candidates.length === 0 ? <p className="text-small text-muted-foreground">There are no other active members to hand over to. Invite someone first.</p> : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Member" className="min-w-64">{(c) => (
                <Select {...c} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">Choose a member…</option>
                  {candidates.map((m) => <option key={m.id} value={m.id}>{name(m)} ({ROLE_LABEL[m.role]})</option>)}
                </Select>
              )}</Field>
              <label className="flex min-h-10 items-center gap-2 text-small"><input type="checkbox" checked={alsoStepDown} onChange={(e) => setAlsoStepDown(e.target.checked)} /> Step down to Admin afterwards</label>
              <Button disabled={!chosen} onClick={() => { save.reset(); setFlow('transfer'); }}>Make owner…</Button>
            </div>
          )}
        </section>
      ) : null}
      {isOwner ? (
        <section aria-labelledby="own-step" className="space-y-3">
          <SectionHeader variant="ruled" as="h2" title={<span id="own-step">Step down</span>} />
          <p className="text-small text-muted-foreground">You become an Admin and keep access. This works only while another active owner remains.</p>
          <Button variant="outline" onClick={() => { save.reset(); setFlow('step-down'); }}>Step down as owner…</Button>
        </section>
      ) : null}
      <section aria-labelledby="own-leave" className="space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="own-leave">Leave this business</span>} />
        <p className="text-small text-muted-foreground">You lose access to {env.businessName}, your assignments are cleared and mailboxes you connected are disconnected. {isOwner ? 'The last active owner cannot leave. ' : ''}An owner or admin can invite you back.</p>
        <Button variant="destructive" onClick={() => { save.reset(); setFlow('leave'); }}>Leave business…</Button>
      </section>
      {flow ? (
        <ConfirmDialog
          open busy={save.busy} error={save.error} phrase={env.businessName} onConfirm={confirm} onCancel={close} destructive={flow === 'leave'}
          title={flow === 'transfer' && chosen ? `Make ${name(chosen)} an owner?` : flow === 'step-down' ? 'Step down as owner?' : `Leave ${env.businessName}?`}
          description={flow === 'transfer' && chosen
            ? <p>{name(chosen)} becomes an owner of {env.businessName}.{alsoStepDown ? ' You become an Admin straight away.' : ' You stay an owner.'} This is recorded in the audit log.</p>
            : flow === 'step-down' ? <p>You become an Admin of {env.businessName}. Only another owner can make you an owner again.</p>
            : <p>You will lose access to {env.businessName} immediately.</p>}
          confirmLabel={flow === 'transfer' ? 'Make owner' : flow === 'step-down' ? 'Step down' : 'Leave business'}
        />
      ) : null}
    </ZonePage>
  );
}
