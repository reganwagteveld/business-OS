import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS } from '@/modules/access';

describe('Scheduling permissions (docs/scheduling-s1.md §5)', () => {
  it('every role reads and books; OWNER, ADMIN and MANAGER also manage calendars', () => {
    const keys = ZONE_PERMISSIONS.scheduling;
    expect(keys).toEqual(['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel', 'scheduling:manage_calendars']);
    const matrix = Object.fromEntries(ROLES.map((role) => [role, keys.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    const work = ['scheduling:read', 'scheduling:create', 'scheduling:update', 'scheduling:cancel'];
    expect(matrix).toEqual({
      OWNER: [...work, 'scheduling:manage_calendars'],
      ADMIN: [...work, 'scheduling:manage_calendars'],
      MANAGER: [...work, 'scheduling:manage_calendars'],
      MEMBER: work,
    });
  });

});
