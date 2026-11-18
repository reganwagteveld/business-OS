import type { Role } from '@business-os/contracts';
import { Alert, AlertDescription, Button, Field, Input, PixelMarker, Select, SectionHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useMemo, useState, type FormEvent } from 'react';
import type { InvitationData, IssuedInvitation } from '../../api/settings';
import type { Outcome } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import type { SettingsPageEnv } from './business-profile';
import { ConfirmDialog } from './confirm';
import { dateLabel } from './members';
import { useSave } from './save';
import { assignableRoles, canAssignRole, ROLE_LABEL } from './team-rules';

type Pending = { kind: 'resend' | 'revoke'; invitation: InvitationData };

/**
 * Business › Invitations (members:invite). Send, see what is open, resend and revoke. An invitation is
 * saved before its email is sent, so a failed delivery is shown with a way to resend, never hidden.
 * Resend replaces the link at once (the old one stops working) and the server allows one a minute.
 */
export function InvitationsPage({ env }: { env: SettingsPageEnv }) {
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [email, setEmail] = useState('');
  // Expiry is judged against the time the list was opened; the server refuses an expired link regardless.
  const [now] = useState(() => Date.now());
  const actor = useMemo(() => ({ role: env.me.role, permissions: env.me.permissions }), [env.me.role, env.me.permissions]);
  const roles = assignableRoles(actor, 'invite') as Exclude<Role, 'OWNER'>[];
  const [role, setRole] = useState<Exclude<Role, 'OWNER'>>(roles[roles.length - 1] ?? 'MEMBER');
  const send = useSave(env.onSessionEnded);
  const act = useSave(env.onSessionEnded);
  const load = useLoad(`settings-invitations|${env.slug}|${generation}`, (signal) => env.client.invitations(env.slug, signal));
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const reload = () => setGeneration((g) => g + 1);
  const title = 'Invitations';
  const description = 'Invite people by email. Each invitation works once and expires after 7 days.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading invitations…' }} />;
  if (current.kind !== 'ok') return <ZonePage title={title} description={description}><Problem outcome={current} what="Invitations" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;

  const issued = (to: string) => (result: IssuedInvitation) => {
    setNotice(result.delivery === 'sent'
      ? { tone: 'success', text: `Invitation sent to ${to}.` }
      : { tone: 'warning', text: `The invitation for ${to} was saved, but the email could not be sent. Use Resend to try again.` });
    reload();
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    await send.run(() => env.client.invite(env.slug, { email, role }), (result) => { issued(email.trim().toLowerCase())(result); setEmail(''); });
  }
  const confirm = () => {
    if (!pending) return;
    const to = pending.invitation.email;
    setNotice(null);
    const call: () => Promise<Outcome<unknown>> = pending.kind === 'resend' ? () => env.client.resendInvitation(env.slug, pending.invitation.id) : () => env.client.revokeInvitation(env.slug, pending.invitation.id);
    return act.run(call, (result) => {
      if (pending.kind === 'resend') issued(to)(result as IssuedInvitation);
      else { setNotice({ tone: 'success', text: `The invitation for ${to} was revoked.` }); reload(); }
      setPending(null);
      act.reset();
    });
  };
  const invitations = current.data;

  return (
    <ZonePage title={title} description={description}>
      {notice ? <Alert tone={notice.tone}><AlertDescription>{notice.text}</AlertDescription></Alert> : null}
      <form onSubmit={submit} noValidate aria-label="Invite someone" className="space-y-4">
        <SectionHeader variant="ruled" as="h2" title="Invite someone" />
        {send.error ? <Alert tone="danger"><AlertDescription>{send.error}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Email address" error={send.fields.email} className="min-w-64 flex-1">{(c) => <Input {...c} type="email" autoComplete="off" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Role">{(c) => (
            <Select {...c} value={role} onChange={(e) => setRole(e.target.value as Exclude<Role, 'OWNER'>)}>
              {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </Select>
          )}</Field>
          <Button type="submit" loading={send.busy} disabled={email.trim() === ''}>Send invitation</Button>
        </div>
      </form>
      <section aria-labelledby="open-invitations" className="min-w-0 space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="open-invitations">Open invitations</span>} meta={`${invitations.length} open`} />
        {invitations.length === 0 ? <p className="text-small text-muted-foreground">No open invitations. Invitations you send appear here until they are accepted or revoked.</p> : (
          <div className="relative overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Status</TableHead><TableHead>Expires</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((inv) => {
                  const expired = new Date(inv.expiresAt).getTime() < now;
                  const mine = canAssignRole(actor, inv.role, 'invite');
                  return (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.email}</TableCell>
                      <TableCell>{ROLE_LABEL[inv.role]}</TableCell>
                      <TableCell>{expired ? <PixelMarker tone="danger">Expired</PixelMarker> : <PixelMarker tone="info" hollow>Pending</PixelMarker>}</TableCell>
                      <TableCell>{dateLabel(inv.expiresAt, env.locale, env.timeZone)}</TableCell>
                      <TableCell>
                        {mine ? (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" variant="outline" aria-label={`Resend invitation to ${inv.email}`} onClick={() => { act.reset(); setPending({ kind: 'resend', invitation: inv }); }}>Resend</Button>
                            <Button size="sm" variant="outline" aria-label={`Revoke invitation to ${inv.email}`} onClick={() => { act.reset(); setPending({ kind: 'revoke', invitation: inv }); }}>Revoke</Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {pending ? (
        <ConfirmDialog
          open busy={act.busy} error={act.error} onConfirm={confirm} onCancel={() => { setPending(null); act.reset(); }}
          title={pending.kind === 'resend' ? `Resend the invitation to ${pending.invitation.email}?` : `Revoke the invitation to ${pending.invitation.email}?`}
          description={pending.kind === 'resend'
            ? <p>A new email goes out with a new link valid for 7 days. The previous link stops working immediately. You can resend once a minute.</p>
            : <p>The link in the invitation stops working immediately. You can invite them again later.</p>}
          confirmLabel={pending.kind === 'resend' ? 'Resend invitation' : 'Revoke invitation'} destructive={pending.kind === 'revoke'}
        />
      ) : null}
    </ZonePage>
  );
}
