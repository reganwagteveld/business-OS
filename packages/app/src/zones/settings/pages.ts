/**
 * The Settings pages this build offers. A page exists here only when the backend it needs exists:
 * nothing is listed as "coming soon" and nothing is shown disabled. `requires` are existing API
 * permission keys, ALL of which the membership must hold; the API still checks every request.
 *
 * Account scope: the signed-in person, whatever their role. Business scope: the active business.
 * Account pages (A3-A) need no business permission key: the server acts on the signed-in person only.
 */
import { zoneLinksFor } from './zone-links';

export type SettingsScope = 'account' | 'business';

export interface SettingsPageDefinition {
  id: string;
  scope: SettingsScope;
  label: string;
  description: string;
  requires: readonly string[];
  /** An extra rule on the permission keys, for a page that only exists when something is reachable. */
  when?: (permissions: readonly string[]) => boolean;
}

export const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  { id: 'account-profile', scope: 'account', label: 'Profile', description: 'Your name, in every business.', requires: [] },
  { id: 'password', scope: 'account', label: 'Password', description: 'Change the password you sign in with.', requires: [] },
  { id: 'devices', scope: 'account', label: 'Signed-in devices', description: 'Where your account is signed in.', requires: [] },
  { id: 'preferences', scope: 'account', label: 'Preferences', description: 'How Pixa OS looks on this device.', requires: [] },
  { id: 'profile', scope: 'business', label: 'Business profile', description: 'Your business’s name, contact details and address.', requires: ['business:read'] },
  { id: 'regional', scope: 'business', label: 'Regional settings', description: 'Country, time zone, language, currency and financial year.', requires: ['business:read'] },
  { id: 'members', scope: 'business', label: 'Members', description: 'Who is in this business and what they can do.', requires: ['members:read'] },
  { id: 'invitations', scope: 'business', label: 'Invitations', description: 'Invite people and manage open invitations.', requires: ['members:invite'] },
  // Every member may read the fixed roles (D-A3 §8, A2-C `GET /access/roles` needs only business:read).
  { id: 'access', scope: 'business', label: 'Roles and access', description: 'The fixed roles and what each one can do.', requires: ['business:read'] },
  { id: 'ownership', scope: 'business', label: 'Ownership and leaving', description: 'Hand over ownership, step down or leave.', requires: ['business:read'] },
  { id: 'zones', scope: 'business', label: 'Zone configuration', description: 'Where each part of Pixa OS keeps its own settings.', requires: ['business:read'], when: (permissions) => zoneLinksFor(permissions).length > 0 },
];

export function pagesFor(scope: SettingsScope, permissions: readonly string[]): SettingsPageDefinition[] {
  const held = new Set(permissions);
  return SETTINGS_PAGES.filter((page) => page.scope === scope && page.requires.every((key) => held.has(key)) && (page.when?.(permissions) ?? true));
}

/** The page a route points at, or the scope's first available page. Unknown or unpermitted ids never open. */
export function resolvePage(scope: SettingsScope, id: string | undefined, permissions: readonly string[]): SettingsPageDefinition | null {
  const pages = pagesFor(scope, permissions);
  return pages.find((page) => page.id === id) ?? pages[0] ?? null;
}

export const isScope = (value: string | undefined): value is SettingsScope => value === 'account' || value === 'business';
