import type { MailConnection } from '@business-os/contracts';
import type { Outcome } from '../../api/tenancy';

export const PROVIDER_NAME = { GOOGLE: 'Google', MICROSOFT: 'Microsoft 365' } as const;

/** Hosts a provider consent may open. Anything else is refused, whatever the API returned. */
const CONSENT_HOSTS = new Set(['accounts.google.com', 'login.microsoftonline.com']);
export function safeConsentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && CONSENT_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export const SYNC_NOTICE = 'Reading and sending mail in Pixa OS is not available yet. Connected mailboxes are recorded here, but no mail is synced or shown.';

export function statusOf(c: MailConnection): { label: string; tone: 'success' | 'warning' | 'neutral'; help: string } {
  if (c.status === 'DISCONNECTED') return { label: 'Disconnected', tone: 'neutral', help: 'This mailbox is disconnected. Connect it again to use it.' };
  if (c.status === 'NEEDS_REAUTH') return { label: 'Needs reconnecting', tone: 'warning', help: errorText(c.lastErrorCode) ?? 'The provider sign-in needs to be renewed.' };
  return { label: 'Connected', tone: 'success', help: 'The provider sign-in is active.' };
}

export function errorText(code: string | null): string | null {
  switch (code) {
    case null: return null;
    case 'reauth_required': return 'The provider asked for a new sign-in. Reconnect the mailbox.';
    case 'owner_inactive': return 'The member who connected this mailbox is no longer active. Reconnect it to continue.';
    case 'holder_departed': return 'The member who held this mailbox sign-in has left. Reconnect it to continue.';
    default: return 'The last attempt failed. Reconnect the mailbox, or ask an administrator.';
  }
}

export const sharingLabel = (c: MailConnection) =>
  c.kind === 'BUSINESS' ? 'Named members' : c.sharing === 'BUSINESS' ? 'Shared with the business' : 'Only the owner';

/** Server reasons for a refused change, in words a person can act on. */
export function reasonFor(outcome: Outcome<unknown>, what: string): string {
  switch (outcome.kind) {
    case 'conflict':
      switch (outcome.code) {
        case 'stale': return 'Someone else changed this. Reload to see the latest, then try again.';
        case 'retention_not_set': return 'Set the ordinary retention period first (Retention tab). It is required before business sync or sharing a personal mailbox.';
        case 'already_connected': return 'This mailbox is already connected in this business.';
        case 'provider_not_configured': return 'This provider is not set up for this deployment.';
        case 'disconnected': return 'This mailbox is disconnected.';
        case 'not_active': return 'This mailbox needs to be reconnected first.';
        case 'attestation_required': return 'This is a consumer address. An owner must accept the business-use confirmation.';
        case 'domain_not_verified': return 'The DNS record was not found yet. It can take a while to appear; try again later.';
        case 'consumer_domain': return 'This is a consumer address (such as gmail.com). An owner must confirm business use before it can be added.';
        case 'attestation_not_applicable': return 'That confirmation is only for consumer addresses.';
        case 'address_in_use': return 'This address is already set up as a business address.';
        case 'already_designated': return 'This address is already set up as a business address.';
        case 'domain_exists': return 'This domain was already added.';
        case 'domain_in_use': return 'A business address uses this domain. Remove that address first.';
        case 'already_verified': return 'This domain is already verified.';
        case 'dns_unavailable': return 'The DNS lookup is unavailable right now. Try again later.';
        case 'personal_connection_exists': return 'You already have a personal mailbox connected for this provider.';
        case 'sync_disabled': return 'Sync is switched off for this mailbox.';
        case 'erased': return 'This was removed by an erasure request.';
        default: return `${what} conflicts with the current state. Reload and try again.`;
      }
    case 'forbidden': return `Your role does not allow this. Nothing was changed.`;
    case 'not_found': return 'This no longer exists, or you cannot see it.';
    case 'invalid_input': return outcome.message;
    case 'rate_limited': return 'Too many requests. Wait a moment and try again.';
    case 'unreachable': return 'Could not reach Pixa OS. Nothing was changed. Try again.';
    default: return 'Something went wrong. Nothing was changed.';
  }
}

/** Results the OAuth return page hands back (`?mailbox=`): only these exact codes are ever shown. */
export const RETURN_RESULTS: Record<string, { tone: 'success' | 'danger'; text: string }> = {
  connected: { tone: 'success', text: 'Mailbox connected. No mail is read yet.' },
  reconnected: { tone: 'success', text: 'Mailbox reconnected. No mail is read yet.' },
  declined: { tone: 'danger', text: 'Access was not granted, so nothing was connected.' },
  invalid_state: { tone: 'danger', text: 'That connection link expired or was already used. Start again.' },
  insufficient_scope: { tone: 'danger', text: 'Not every requested permission was allowed. Nothing was connected.' },
  account_mismatch: { tone: 'danger', text: 'You signed in with a different mailbox than the one being reconnected. Nothing was changed.' },
  already_connected: { tone: 'danger', text: 'Someone in this business already connected this mailbox. Nothing was changed.' },
  not_allowed: { tone: 'danger', text: 'You are not allowed to connect mailboxes in this business.' },
  error: { tone: 'danger', text: 'The provider did not complete the connection. Nothing was connected.' },
};
