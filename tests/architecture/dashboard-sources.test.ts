// R2 operational dashboard (docs/dashboard-r2.md): the widget table in the client must match the API. Every
// widget names an endpoint the shared contract declares and permission keys the server's registry defines,
// and with the server's own role defaults a Member sees no Finance widget at all.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../apps/api/src/modules/access/server/permissions';
import { endpoints } from '../../packages/contracts/src/index';
import { DASHBOARD_SOURCES, visibleWidgets } from '../../packages/app/src/shell/dashboard/sources';

describe('operational dashboard sources', () => {
  it('every widget reads a declared endpoint with permission keys the server defines', () => {
    const declared = Object.values(endpoints).map((e) => `${e.method} ${e.path.replace('/api/v1/b/:slug', '')}`);
    for (const s of DASHBOARD_SOURCES) {
      const [method, rest] = s.endpoint.split(' ') as [string, string];
      expect(declared, s.id).toContain(`${method} ${rest.split('?')[0]}`);
      for (const p of s.requires) expect(ALL_PERMISSIONS as readonly string[], `${s.id}: ${p}`).toContain(p);
    }
  });

  it("with the server's role defaults, Member sees no Finance widget; Owner, Admin and Manager see them all", () => {
    const of = (role: keyof typeof ROLE_PERMISSIONS) => visibleWidgets([...ROLE_PERMISSIONS[role]]);
    const finance = DASHBOARD_SOURCES.filter((s) => s.requires.includes('finance:read')).map((s) => s.id);
    expect(finance.length).toBeGreaterThan(0);
    for (const id of finance) expect(of('MEMBER').has(id), id).toBe(false);
    for (const role of ['OWNER', 'ADMIN', 'MANAGER'] as const) expect(of(role).size, role).toBe(DASHBOARD_SOURCES.length);
    expect(of('MEMBER').size).toBe(DASHBOARD_SOURCES.length - finance.length);
  });

  it('Home is mounted per business, membership and permission set, so no figure outlives the access it was loaded with', () => {
    const app = readFileSync(new URL('../../packages/app/src/app.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/<HomeWithMetrics key=\{dashboardIdentity\(active\)\}/);
  });
});
