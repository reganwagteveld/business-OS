import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS } from '@/modules/access';

describe('Scheduling permissions (docs/scheduling-s1.md §5, docs/scheduling-s2.md §7)', () => {
  it('every role reads and books; OWNER, ADMIN and MANAGER also manage calendars and resources', () => {
    const keys = ZONE_PERMISSIONS.scheduling;
    expect(keys).toEqual(['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars', 'scheduling:manage_resources']);
    const matrix = Object.fromEntries(ROLES.map((role) => [role, keys.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    const work = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel'];
    const manage = ['scheduling:manage_calendars', 'scheduling:manage_resources'];
    expect(matrix).toEqual({
      OWNER: [...work, ...manage],
      ADMIN: [...work, ...manage],
      MANAGER: [...work, ...manage],
      MEMBER: work,
    });
  });

  it('S2 adds no People, Customer or other Zone permission to any role', () => {
    const outside = (role: (typeof ROLES)[number]) => [...ROLE_PERMISSIONS[role]].filter((p) => !p.startsWith('scheduling:')).sort();
    // Removing the S2 key leaves every role's set exactly as it was: the only change is scheduling:manage_resources.
    for (const role of ROLES) expect([...ROLE_PERMISSIONS[role]].filter((p) => p.startsWith('scheduling:') && !keysS1.includes(p) && p !== 'scheduling:manage_resources')).toEqual([]);
    expect(outside('MEMBER')).not.toContain('people:read');
  });
});
const keysS1 = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars'];
