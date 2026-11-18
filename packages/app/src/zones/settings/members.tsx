import type { Role } from '@business-os/contracts';
import { Alert, AlertDescription, Button, PixelMarker, Select, SectionHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useState } from 'react';
import type { AccessModelData, MemberData } from '../../api/settings';
import type { Outcome } from '../../api/tenancy';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import type { SettingsPageEnv } from './business-profile';
import { mailboxCutoff, mailboxCutoffSentence } from './access-model';
import { ConfirmDialog } from './confirm';
import { useSave } from './save';
import { assignableRoles, canManageMember, ROLE_LABEL, ROLE_ORDER } from './team-rules';

type Action = { kind: 'role'; member: MemberData; role: Role } | { kind: 'suspend' | 'reactivate' | 'remove'; member: MemberData };

export const dateLabel = (iso: string, locale: string, timeZone: string) => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};
const displayName = (m: MemberData) => m.name || m.email || 'Unnamed member';

/**
 * Business › Members. Everyone with members:read sees the directory. Emails appear only when the server
 * sends them (members:invite). A row offers only the actions the person may take on that member, by the
 * same rank rules the server enforces again on every request.
 */
export function MembersPage({ env }: { env: SettingsPageEnv }) {
  const [generation, setGeneration] = useState(0);
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useSave(env.onSessionEnded);
  const load = useLoad(`settings-members|${env.slug}|${generation}`, (signal) => env.client.members(env.slug, signal));
  // The roles description only sharpens the mailbox wording in a role-change confirmation. If it cannot be
  // read, the page still works and the confirmation falls back to the general rule.
  const roles = useLoad(`settings-members-roles|${env.slug}`, (signal) => env.client.accessRoles(env.slug, signal));
  const model = roles.state.status === 'done' && roles.state.outcome.kind === 'ok' ? roles.state.outcome.data : null;
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const reload = () => setGeneration((g) => g + 1);
  const title = 'Members';
  const description = 'Everyone in this business, their role and whether they can sign in.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading members…' }} />;
  if (current.kind !== 'ok') return <ZonePage title={title} description={description}><Problem outcome={current} what="Members" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;

  const members = current.data;
  const showEmail = env.me.permissions.includes('members:invite');
  const actor = { role: env.me.role, permissions: env.me.permissions };
  const close = () => { setAction(null); save.reset(); };
  const run = (call: () => Promise<Outcome<unknown>>, message: string) =>
    save.run(call, () => { setNotice(message); close(); reload(); if (action?.kind === 'role') env.onSaved(); });
  const confirm = () => {
    if (!action) return;
    const name = displayName(action.member);
    if (action.kind === 'role') return run(() => env.client.changeRole(env.slug, action.member.id, action.role), `${name} is now ${ROLE_LABEL[action.role]}.`);
    if (action.kind === 'suspend') return run(() => env.client.setMemberStatus(env.slug, action.member.id, 'SUSPENDED'), `${name} is suspended.`);
    if (action.kind === 'reactivate') return run(() => env.client.setMemberStatus(env.slug, action.member.id, 'ACTIVE'), `${name} can sign in again.`);
    return run(() => env.client.removeMember(env.slug, action.member.id), `${name} was removed.`);
  };

  return (
    <ZonePage title={title} description={description}>
      {notice ? <Alert tone="success"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <section aria-labelledby="members-list" className="min-w-0 space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="members-list">Directory</span>} meta={`${members.length} ${members.length === 1 ? 'person' : 'people'}`} />
        <div className="relative overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {showEmail ? <TableHead>Email</TableHead> : null}
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const isSelf = m.id === env.me.membershipId;
                const manage = canManageMember(actor, m.role, isSelf);
                const roles = manage ? assignableRoles(actor, 'change').filter((r) => r !== m.role && (r !== 'OWNER' || m.status === 'ACTIVE')) : [];
                return (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap font-medium">{displayName(m)}{isSelf ? <span className="ml-2 text-caption font-normal text-fg-subtle">You</span> : null}<span className="block text-caption font-normal text-fg-subtle">Joined {dateLabel(m.createdAt, env.locale, env.timeZone)}</span></TableCell>
                    {showEmail ? <TableCell>{m.email ?? <span className="text-fg-subtle">Hidden</span>}</TableCell> : null}
                    <TableCell>{ROLE_LABEL[m.role]}</TableCell>
                    <TableCell>{m.status === 'ACTIVE' ? <PixelMarker tone="success">Active</PixelMarker> : <PixelMarker tone="warning" hollow>Suspended</PixelMarker>}</TableCell>
                    <TableCell>
                      {manage ? (
                        <div className="flex flex-nowrap items-center justify-end gap-2 whitespace-nowrap">
                          {roles.length > 0 ? (
                            <Select aria-label={`Change role for ${displayName(m)}`} className="h-8 w-36 text-xs" value="" onChange={(e) => e.target.value && setAction({ kind: 'role', member: m, role: e.target.value as Role })}>
                              <option value="">Change role…</option>
                              {ROLE_ORDER.filter((r) => roles.includes(r)).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </Select>
                          ) : null}
                          <Button size="sm" variant="outline" aria-label={`${m.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'} ${displayName(m)}`} onClick={() => setAction({ kind: m.status === 'ACTIVE' ? 'suspend' : 'reactivate', member: m })}>{m.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}</Button>
                          <Button size="sm" variant="outline" aria-label={`Remove ${displayName(m)}`} onClick={() => setAction({ kind: 'remove', member: m })}>Remove</Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {members.length === 0 ? <p className="text-small text-muted-foreground">No members to show.</p> : null}
        {env.me.role === 'OWNER' ? <p className="text-small text-muted-foreground">To make someone an owner, or to step down yourself, use <button type="button" className="font-medium underline" onClick={() => env.go('ownership')}>Ownership and leaving</button>.</p> : null}
      </section>
      {action ? (
        <ConfirmDialog
          open title={dialogTitle(action)} description={dialogBody(action, model)} busy={save.busy} error={save.error}
          phrase={action.kind === 'remove' ? displayName(action.member) : undefined}
          confirmLabel={action.kind === 'remove' ? 'Remove member' : action.kind === 'suspend' ? 'Suspend' : action.kind === 'reactivate' ? 'Reactivate' : 'Change role'}
          destructive={action.kind === 'remove' || action.kind === 'suspend'} onConfirm={confirm} onCancel={close}
        />
      ) : null}
    </ZonePage>
  );
}

function dialogTitle(a: Action) {
  const name = displayName(a.member);
  return a.kind === 'role' ? `Make ${name} ${ROLE_LABEL[a.role]}?` : a.kind === 'suspend' ? `Suspend ${name}?` : a.kind === 'reactivate' ? `Reactivate ${name}?` : `Remove ${name}?`;
}

/** What a role change does to the member's mailbox connections (the server revokes them in the same transaction). */
function roleMailboxText(a: Extract<Action, { kind: 'role' }>, model: AccessModelData | null): string {
  if (a.member.status !== 'ACTIVE') return 'They stay suspended until someone reactivates them.';
  if (!model) return 'If the new role cannot connect mailboxes, mailboxes they connected are disconnected now.';
  return mailboxCutoffSentence(mailboxCutoff(model, a.member.role, a.role)) ?? 'Mailboxes they connected stay connected.';
}

function dialogBody(a: Action, model: AccessModelData | null) {
  switch (a.kind) {
    case 'role': return <p>{displayName(a.member)} changes from {ROLE_LABEL[a.member.role]} to {ROLE_LABEL[a.role]}. Their access changes on their next request. {roleMailboxText(a, model)}</p>;
    case 'suspend': return <p>They lose access at their next request. Their assignments and history are kept, and mailboxes they connected are disconnected now. Reactivating restores access but not mailbox connections.</p>;
    case 'reactivate': return <p>They can sign in and use this business again with their current role. Mailboxes they connected stay disconnected until they reconnect them.</p>;
    case 'remove': return <p>They lose access, their assignments are cleared and mailboxes they connected are disconnected now. Their past work and history are kept. If you may want them back, suspend them instead.</p>;
  }
}
