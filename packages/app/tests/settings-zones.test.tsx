// @vitest-environment jsdom
// A3 / A2-D stage 3: the Zone configuration hub only links to configuration that exists, filtered by permission keys.
import { describe, expect, it } from 'vitest';
import { pagesFor } from '../src/zones/settings/pages';
import { ZONE_LINKS, zoneLinksFor } from '../src/zones/settings/zone-links';
import { ZONES } from '../src/shell/registry';

describe('Zone configuration hub', () => {
  it('appears only when at least one linked Zone is open to the person', () => {
    expect(pagesFor('business', ['business:read']).map((p) => p.id)).not.toContain('zones');
    expect(pagesFor('business', ['business:read', 'finance:read']).map((p) => p.id)).toContain('zones');
    expect(pagesFor('business', ['finance:read']).map((p) => p.id)).not.toContain('zones'); // needs business:read too
  });

  it('lists links by permission key', () => {
    expect(zoneLinksFor(['business:read']).map((l) => l.id)).toEqual([]);
    expect(zoneLinksFor(['finance:read']).map((l) => l.id)).toEqual(['finance-settings', 'finance-catalog']);
    expect(zoneLinksFor(['finance:read', 'people:read']).map((l) => l.id)).toEqual(['finance-settings', 'finance-catalog', 'people-org']);
  });

  it('only links to destinations the shell has: a built Zone and, for a child, a registered child', () => {
    for (const link of ZONE_LINKS) {
      const zone = ZONES.find((z) => z.id === link.route.zone);
      expect(zone?.availability, link.id).toBe('built');
      expect(link.requires.every((k) => zone!.requires.includes(k)), link.id).toBe(true); // never looser than the Zone's own key
      if ('child' in link.route && link.route.child) expect(zone!.children?.map((c) => c.id), link.id).toContain(link.route.child);
    }
  });
});
