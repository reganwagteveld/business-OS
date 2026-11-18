import type { ShellRoute } from '../../shell/registry';

/**
 * Where each Zone keeps its own configuration. This hub only LINKS to configuration that already exists in a
 * Zone: it never edits it, and it lists nothing without a destination. Each link is shown only when the
 * Zone's own route is open to the person (the same existing permission key the shell uses), and the Zone
 * and API check access again.
 */
export interface ZoneLink {
  id: string;
  zone: string;
  label: string;
  description: string;
  requires: readonly string[];
  route: ShellRoute;
  /** Whether the person may change it (presentation only); otherwise the destination is read-only. */
  editKey?: string;
}

export const ZONE_LINKS: readonly ZoneLink[] = [
  { id: 'finance-settings', zone: 'Finance', label: 'Finance settings', description: 'Seller details, document numbering, tax rates and quote and invoice templates.', requires: ['finance:read'], route: { zone: 'finance', child: 'settings' }, editKey: 'finance:manage' },
  { id: 'finance-catalog', zone: 'Finance', label: 'Products & services', description: 'The catalog you quote and invoice from.', requires: ['finance:read'], route: { zone: 'finance', child: 'catalog' }, editKey: 'finance:catalog' },
  { id: 'people-org', zone: 'People', label: 'Departments and locations', description: 'How your team is organised. Open People, then Departments or Locations.', requires: ['people:read'], route: { zone: 'people' }, editKey: 'people:configure' },
];

export const zoneLinksFor = (permissions: readonly string[]): ZoneLink[] => {
  const held = new Set(permissions);
  return ZONE_LINKS.filter((link) => link.requires.every((key) => held.has(key)));
};
