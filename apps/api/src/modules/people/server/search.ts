import 'server-only';
// Global search provider for the People Zone (docs/global-search-gs1.md §6.4, D-GS1-3, D-GS1-4). WORK
// FIELDS ONLY, for people:read: names, employee number, work email and job title, and the current
// department's name. This file must never reference the personal-details table, history reasons,
// manager assignments or leave (a source-rule test enforces it). Former staff are returned with a
// "former" badge and rank below current staff.
import { sql } from '@/core/db';
import { candidates, finalize, prefixIndex, tenantOf, wordIndex, type SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';

const EMPLOYEE_WORDS = `given_name || ' ' || family_name || ' ' || coalesce(preferred_name, '') || ' ' || coalesce(job_title, '')`;

export const employeeSearchProvider: SearchProvider<Permission> = {
  type: 'employee',
  zone: 'people',
  requires: ['people:read'],
  matchFields: ['given_name', 'family_name', 'preferred_name', 'employee_number', 'work_email', 'job_title'],
  resultFields: ['given_name', 'preferred_name', 'family_name', 'job_title', 'status', 'department.name'],
  branch(input) {
    const ctes = candidates({
      table: 'people_employees', columns: 'id, given_name, family_name, preferred_name, job_title, status', live: 'TRUE',
      arms: [
        { column: 'given_name', exactTier: 1, prefixTier: 2 },
        { column: 'family_name', exactTier: 1, prefixTier: 2 },
        { column: 'preferred_name', exactTier: 1, prefixTier: 2 },
        { column: 'employee_number', exactTier: 1, prefixTier: 4 },
        { column: 'work_email', exactTier: 1, prefixTier: 4 },
      ],
      words: EMPLOYEE_WORDS,
    }, input);
    return finalize(ctes, sql`
      SELECT 'employee'::text AS type, m.id, m.tier, CASE WHEN m.status::text = 'TERMINATED' THEN 1 ELSE 0 END AS demote,
             lower(coalesce(m.preferred_name, m.given_name) || ' ' || m.family_name) AS sort_key,
             coalesce(m.preferred_name, m.given_name) || ' ' || m.family_name AS title,
             nullif(concat_ws(' · ', nullif(m.job_title, ''), nullif(d.name, '')), '') AS subtitle,
             array_remove(ARRAY[CASE WHEN m.status::text = 'TERMINATED' THEN 'former' END], NULL)::text[] AS badges,
             m.id::text AS target
      FROM m
      LEFT JOIN people_department_assignments a ON ${tenantOf(input, 'a.business_id')} AND a.employee_id = m.id AND a.ends_on IS NULL
      LEFT JOIN people_departments d ON ${tenantOf(input, 'd.business_id')} AND d.id = a.department_id`, input);
  },
};

export const PEOPLE_SEARCH_INDEXES = [
  prefixIndex('people_employees', 'given_name'), prefixIndex('people_employees', 'family_name'), prefixIndex('people_employees', 'preferred_name'),
  prefixIndex('people_employees', 'employee_number'), prefixIndex('people_employees', 'work_email'), wordIndex('people_employees', EMPLOYEE_WORDS),
];
