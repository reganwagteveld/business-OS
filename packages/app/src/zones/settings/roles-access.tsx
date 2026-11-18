import type { Role } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Button, cn, PixelMarker, SectionHeader } from '@business-os/ui';
import type { AccessModelData } from '../../api/settings';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { listRoles, MAILBOX_KEYS, matchesMembership, rolesWith } from './access-model';
import type { SettingsPageEnv } from './business-profile';
import { Facts } from './parts';

const RULE_LABEL: Record<AccessModelData['rules'][number]['id'], string> = {
  transfer_ownership: 'Hand over ownership',
  step_down: 'Step down as owner',
  attest_business_mailbox: 'Approve a personal address as a business mailbox',
  leave_business: 'Leave the business',
};

/**
 * Business › Roles and access (A2-D, read-only). Explains the four fixed roles from the server's own
 * description (A2-C, `GET /access/roles`, computed from the live grants), so it cannot drift from what the
 * server enforces. Nothing here can be edited and there are no custom roles (D-A2-1): changing a member's
 * role happens on Members, under the rank rules the server checks on every request. Every member may read it.
 */
export function RolesAccessPage({ env }: { env: SettingsPageEnv }) {
  const load = useLoad(`settings-roles|${env.slug}`, (signal) => env.client.accessRoles(env.slug, signal));
  const current = load.state.status === 'done' ? load.state.outcome : load.previous;
  const title = 'Roles and access';
  const description = 'The four roles in this business and what each one can do. Roles are fixed: they cannot be edited, and custom roles are not available.';
  if (!current) return <ZonePage title={title} description={description} state={{ kind: 'loading', label: 'Loading roles…' }} />;
  if (current.kind !== 'ok') return <ZonePage title={title} description={description}><Problem outcome={current} what="Roles and access" onRetry={load.reload} onSessionEnded={env.onSessionEnded} /></ZonePage>;

  const model = current.data;
  const mine = model.roles.find((r) => r.role === env.me.role);
  const inSync = matchesMembership(model, env.me.role, env.me.permissions);
  const held = new Set(env.me.permissions);

  return (
    <ZonePage title={title} description={description}>
      {!inSync ? (
        <Alert tone="warning">
          <AlertTitle>Your access may have changed</AlertTitle>
          <AlertDescription>
            <p>What this business says you can do differs from the description of your role. Your role may have been changed while this page was open.</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={env.onSaved}>Refresh my access</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {mine ? (
        <section aria-labelledby="roles-mine" className="min-w-0 space-y-3">
          <SectionHeader variant="ruled" as="h2" title={<span id="roles-mine">Your role</span>} meta={mine.label} />
          <Facts items={[
            { label: 'Role', value: <strong>{mine.label}</strong>, hint: mine.description },
            { label: 'You can invite', value: mine.canInvite.length > 0 ? listRoles(model, mine.canInvite) : 'No one', hint: mine.canInvite.length > 0 ? 'New people join with one of these roles.' : undefined },
            { label: 'You can change, suspend or remove', value: mine.canManage.length > 0 ? `Other members who are ${listRoles(model, mine.canManage)}` : 'No one', hint: mine.canManage.length > 0 ? 'Never your own membership.' : undefined },
            { label: 'You can give these roles', value: mine.canAssign.length > 0 ? listRoles(model, mine.canAssign) : 'None' },
          ]} />
          <TeamLinks env={env} held={held} />
        </section>
      ) : null}

      <section aria-labelledby="roles-list" className="min-w-0 space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="roles-list">The four roles</span>} meta="Highest authority first" />
        <ul className="border-t border-line">
          {model.roles.map((r) => (
            <li key={r.role} aria-label={r.label} className="grid gap-1 border-b border-line py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
              <h3 className="text-body font-semibold">
                {r.label}
                {r.role === env.me.role ? <span className="ml-2 text-caption font-normal text-fg-subtle">Your role</span> : null}
              </h3>
              <div className="min-w-0 space-y-1 text-small">
                <p className="text-body">{r.description}</p>
                <p className="text-muted-foreground">Invites: {listRoles(model, r.canInvite)}. Changes, suspends or removes: {r.canManage.length > 0 ? `other members who are ${listRoles(model, r.canManage).replace(/ and /, ' or ')}` : 'no one'}.</p>
                <p className="text-muted-foreground">{r.permissions.length} of {model.zones.reduce((n, z) => n + z.permissions.length, 0)} permissions.</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="roles-rules" className="min-w-0 space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="roles-rules">Rules that protect the business</span>} />
        <Facts items={[
          ...model.rules.map((rule) => ({ label: RULE_LABEL[rule.id], value: rule.roles.length === model.roles.length ? 'Every role' : listRoles(model, rule.roles), hint: rule.description })),
          { label: 'At least one owner', value: 'Always', hint: 'A business always keeps an active owner. The last active owner cannot be given another role, suspended, removed, step down or leave.' },
          { label: 'No one acts on themselves', value: 'Always', hint: 'Nobody changes, suspends or removes their own membership. Owners use step down or leave instead.' },
        ]} />
      </section>

      <MailboxSection model={model} />

      <section aria-labelledby="roles-matrix" className="min-w-0 space-y-3">
        <SectionHeader variant="ruled" as="h2" title={<span id="roles-matrix">What each role can do</span>} meta={`${model.zones.length} areas`} />
        <p className="text-small text-muted-foreground">Pixa OS checks these on every request, whatever a screen shows.</p>
        <Matrix model={model} me={env.me.role} />
      </section>
    </ZonePage>
  );
}

function TeamLinks({ env, held }: { env: SettingsPageEnv; held: ReadonlySet<string> }) {
  const links = [
    held.has('members:read') ? { id: 'members', label: held.has('members:manage') ? 'Change someone’s role in Members' : 'See who has which role in Members' } : null,
    held.has('members:invite') ? { id: 'invitations', label: 'Invite someone' } : null,
  ].filter((l): l is { id: string; label: string } => l !== null);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => <Button key={l.id} size="sm" variant="outline" onClick={() => env.go(l.id)}>{l.label}</Button>)}
    </div>
  );
}

function MailboxSection({ model }: { model: AccessModelData }) {
  const keys = new Set(model.zones.flatMap((z) => z.permissions.map((p) => p.key)));
  if (!keys.has(MAILBOX_KEYS.personal) || !keys.has(MAILBOX_KEYS.business)) return null;
  return (
    <section aria-labelledby="roles-mailboxes" className="min-w-0 space-y-3">
      <SectionHeader variant="ruled" as="h2" title={<span id="roles-mailboxes">Mailbox access follows the role</span>} />
      <Facts items={[
        { label: 'Connect their own mailbox', value: listRoles(model, rolesWith(model, MAILBOX_KEYS.personal)) },
        { label: 'Manage business mailboxes', value: listRoles(model, rolesWith(model, MAILBOX_KEYS.business)) },
        {
          label: 'When access ends',
          value: 'Mailboxes are disconnected at once',
          hint: 'When a member is suspended, removed or leaves, or moves to a role without that access, the mailboxes they connected are disconnected in the same step. Reactivating them or giving the role back does not reconnect them: they connect again themselves.',
        },
      ]} />
    </section>
  );
}

/** One table, grouped by area: a row per permission, a column per role. Words carry the meaning, never colour alone. */
function Matrix({ model, me }: { model: AccessModelData; me: Role }) {
  const grants = new Map(model.roles.map((r) => [r.role, new Set(r.permissions)]));
  const cols = model.roles.length + 1;
  return (
    <div className="relative w-full overflow-x-auto rounded-xl border border-line bg-card">
      <table className="w-full min-w-[40rem] border-collapse text-small">
        <caption className="sr-only">Permissions held by each role</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="px-4 py-2 text-left text-caption font-semibold text-muted-foreground">Permission</th>
            {model.roles.map((r) => (
              <th key={r.role} scope="col" className={cn('w-24 px-3 py-2 text-left text-caption font-semibold text-muted-foreground', r.role === me && 'text-foreground')}>
                {r.label}{r.role === me ? <span className="block font-normal text-fg-subtle">You</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        {model.zones.map((zone) => (
          <tbody key={zone.zone} aria-label={zone.label}>
            <tr className="border-b border-line bg-sunken">
              <th scope="colgroup" colSpan={cols} className="px-4 py-2 text-left text-small font-semibold">{zone.label}</th>
            </tr>
            {zone.permissions.map((perm) => (
              <tr key={perm.key} className="border-b border-line last:border-b-0">
                <th scope="row" className="px-4 py-2 text-left align-top font-normal">
                  <span className="block font-medium">{perm.label}</span>
                  <span className="block text-caption text-fg-subtle">{perm.description}</span>
                </th>
                {model.roles.map((r) => (
                  <td key={r.role} className="px-3 py-2 align-top">
                    {grants.get(r.role)?.has(perm.key)
                      ? <PixelMarker tone="success">Yes</PixelMarker>
                      : <span className="text-fg-subtle">No</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
