import type { Role } from '@business-os/contracts';
import type { AccessModelData } from '../../api/settings';

/**
 * PRESENTATION ONLY. Reads the server's description of the fixed roles (A2-C, `GET /access/roles`) to say
 * what a role means. Nothing here grants, hides or checks anything: every route checks its own permission
 * key on every request, and the screen only explains what the server will do.
 */

/** The keys that let a member hold a mailbox connection (apps/api communications `holderPermission`). */
export const MAILBOX_KEYS = { personal: 'communications:connect', business: 'communications:manage_connections' } as const;

const keysOf = (model: AccessModelData, role: Role): ReadonlySet<string> => new Set(model.roles.find((r) => r.role === role)?.permissions ?? []);

/** Roles (highest first) that hold `key`. */
export const rolesWith = (model: AccessModelData, key: string): Role[] => model.roles.filter((r) => r.permissions.includes(key)).map((r) => r.role);

/**
 * Which mailbox connections a member stops holding when their role changes from `from` to `to`. The server
 * revokes every connection whose holder key the new role lacks, in the same transaction as the change
 * (modules/tenancy `changeRole` → `revokeHeldConnections`). A kind is listed only if `from` could hold it.
 */
export function mailboxCutoff(model: AccessModelData, from: Role, to: Role): { personal: boolean; business: boolean } {
  const before = keysOf(model, from);
  const after = keysOf(model, to);
  return {
    personal: before.has(MAILBOX_KEYS.personal) && !after.has(MAILBOX_KEYS.personal),
    business: before.has(MAILBOX_KEYS.business) && !after.has(MAILBOX_KEYS.business),
  };
}

/** One sentence for a role-change confirmation, or null when the change keeps every mailbox connection. */
export function mailboxCutoffSentence(cutoff: { personal: boolean; business: boolean }): string | null {
  if (cutoff.personal && cutoff.business) return 'The new role cannot hold mailboxes, so every mailbox they connected, their own and the business’s, is disconnected now.';
  if (cutoff.business) return 'The new role cannot manage business mailboxes, so business mailboxes they connected are disconnected now. Their own mailbox stays connected.';
  if (cutoff.personal) return 'The new role cannot connect a mailbox, so mailboxes they connected are disconnected now.';
  return null;
}

/**
 * Whether the server's description of `role` gives exactly the keys the business context says this person
 * holds. A difference means one of the two was read before a change (for example their role was changed
 * while the page was open), so the screen offers a refresh rather than guessing which one is current.
 */
export function matchesMembership(model: AccessModelData, role: Role, permissions: readonly string[]): boolean {
  const described = keysOf(model, role);
  const held = new Set(permissions);
  return described.size === held.size && [...held].every((key) => described.has(key));
}

/** "Owner, Admin and Manager", or `none` when the list is empty. */
export function listRoles(model: AccessModelData, roles: readonly Role[], none = 'No one'): string {
  const labels = model.roles.filter((r) => roles.includes(r.role)).map((r) => r.label);
  if (labels.length === 0) return none;
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
