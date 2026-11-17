/**
 * The Settings pages this build offers. A page exists here only when the backend it needs exists:
 * nothing is listed as "coming soon" and nothing is shown disabled. `requires` are existing API
 * permission keys, ALL of which the membership must hold; the API still checks every request.
 *
 * Account scope: the signed-in person, whatever their role. Business scope: the active business.
 * (Account pages that need server support, such as name, password and sessions, are added with A3-A.)
 */
export type SettingsScope = 'account' | 'business';

export interface SettingsPageDefinition {
  id: string;
  scope: SettingsScope;
  label: string;
  description: string;
  requires: readonly string[];
}

export const SETTINGS_PAGES: readonly SettingsPageDefinition[] = [
  { id: 'preferences', scope: 'account', label: 'Preferences', description: 'How Pixa OS looks on this device.', requires: [] },
  { id: 'profile', scope: 'business', label: 'Business profile', description: 'Your business’s name, contact details and address.', requires: ['business:read'] },
  { id: 'regional', scope: 'business', label: 'Regional settings', description: 'Country, time zone, language, currency and financial year.', requires: ['business:read'] },
];

export function pagesFor(scope: SettingsScope, permissions: readonly string[]): SettingsPageDefinition[] {
  const held = new Set(permissions);
  return SETTINGS_PAGES.filter((page) => page.scope === scope && page.requires.every((key) => held.has(key)));
}

/** The page a route points at, or the scope's first available page. Unknown or unpermitted ids never open. */
export function resolvePage(scope: SettingsScope, id: string | undefined, permissions: readonly string[]): SettingsPageDefinition | null {
  const pages = pagesFor(scope, permissions);
  return pages.find((page) => page.id === id) ?? pages[0] ?? null;
}

export const isScope = (value: string | undefined): value is SettingsScope => value === 'account' || value === 'business';
