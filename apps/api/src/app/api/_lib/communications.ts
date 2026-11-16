import 'server-only';
// Helpers for the activity and communications routes (docs/communications-c1.md §4–5, communications-c2.md §4).
import { RecordNotFoundError } from '@/core/http/errors';
import { authorize, can, canAttestBusinessMailbox } from '@/modules/access';
import type { ActivityViewer } from '@/modules/activity';
import type { BusinessMailboxActor, ConnectionViewer } from '@/modules/communications';
import type { Actor } from '@/modules/tenancy';
import { isUuid } from './routes';

/** A malformed id answers exactly like a missing one (404). */
export const idOf = (name: string) => (params: Record<string, string>): string => {
  const value = params[name];
  if (!isUuid(value)) throw new RecordNotFoundError();
  return value;
};
export const activityIdOf = idOf('activityId');
export const conversationIdOf = idOf('conversationId');

/**
 * The reader of a timeline, from the verified actor only. Timeline entries name customers and
 * contacts, so reading them also needs customers:read (related-record permission).
 */
export function activityViewer(actor: Actor): ActivityViewer {
  authorize(actor, 'customers:read');
  return {
    userId: actor.userId,
    canReadRestricted: can(actor, 'activity:read_restricted'),
    canReadMessages: can(actor, 'communications:read'),
  };
}

/** Conversations name customers and contacts too. */
export function requireCustomerRead(actor: Actor): void {
  authorize(actor, 'customers:read');
}

export const connectionIdOf = idOf('connectionId');

/** The viewer of mailbox connections, from the verified actor only (docs/communications-c2.md §4). */
export function connectionViewer(actor: Actor): ConnectionViewer {
  return {
    userId: actor.userId,
    canRead: can(actor, 'communications:read'),
    canConnect: can(actor, 'communications:connect'),
    canManage: can(actor, 'communications:manage_connections'),
  };
}

export const domainIdOf = idOf('domainId');
export const addressIdOf = idOf('addressId');
export const memberUserIdOf = idOf('userId');

/** The actor for business domains and addresses (C2-B1): a connection viewer that may also attest (OWNER). */
export function businessMailboxActor(actor: Actor): BusinessMailboxActor {
  return { ...connectionViewer(actor), canAttest: canAttestBusinessMailbox(actor) };
}

export const erasureIdOf = idOf('erasureId');
export const holdIdOf = idOf('holdId');

/** The raw session token a privileged erasure route was handed (only those routes opt in; boundary rule). */
export function sessionTokenOf(token: string | null): string {
  if (!token) throw new Error('Privileged erasure route without a session token');
  return token;
}
