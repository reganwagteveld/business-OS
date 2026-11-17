import 'server-only';
// Global search providers for the Projects Zone (docs/global-search-gs1.md §4.1, §8): projects by name,
// tasks by title. Never descriptions, owners, assignees or dates. A project's customer name appears only
// for a caller who can read customers (§6.3), as in the project list.
import { rawSql, sql } from '@/core/db';
import { candidates, finalize, prefixIndex, tenantOf, wordIndex, type SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';

const PROJECT_STATUS = `CASE %s WHEN 'PLANNED' THEN 'Planned' WHEN 'ACTIVE' THEN 'Active' WHEN 'ON_HOLD' THEN 'On hold' WHEN 'COMPLETED' THEN 'Completed' WHEN 'CANCELLED' THEN 'Cancelled' END`;
const TASK_STATUS = `CASE %s WHEN 'TODO' THEN 'To do' WHEN 'IN_PROGRESS' THEN 'In progress' WHEN 'BLOCKED' THEN 'Blocked' WHEN 'DONE' THEN 'Done' END`;
const label = (template: string, column: string) => template.replace('%s', column);

export const projectSearchProvider: SearchProvider<Permission> = {
  type: 'project',
  zone: 'projects',
  requires: ['projects:read'],
  matchFields: ['name'],
  resultFields: ['name', 'status', 'customer.display_name (customers:read only)', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'projects', columns: 'id, name, status, customer_id, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'name', exactTier: 1, prefixTier: 2 }],
      words: 'name',
    }, input);
    const customer = input.canReadCustomers ? sql`c.display_name` : sql`NULL::text`;
    return finalize(ctes, sql`
      SELECT 'project'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.name) AS sort_key, m.name AS title,
             nullif(concat_ws(' · ', nullif(${customer}, ''), ${rawSql(label(PROJECT_STATUS, 'm.status::text'))}), '') AS subtitle,
             array_remove(ARRAY[
               CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END,
               CASE m.status::text WHEN 'COMPLETED' THEN 'completed' WHEN 'CANCELLED' THEN 'cancelled' END
             ], NULL)::text[] AS badges,
             m.id::text AS target
      FROM m LEFT JOIN customers c ON ${tenantOf(input, 'c.business_id')} AND c.id = m.customer_id`, input);
  },
};

export const taskSearchProvider: SearchProvider<Permission> = {
  type: 'task',
  zone: 'projects',
  requires: ['projects:read'],
  matchFields: ['title'],
  resultFields: ['title', 'status', 'project.name', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'project_tasks', columns: 'id, title, status, project_id, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'title', exactTier: 1, prefixTier: 2 }],
      words: 'title',
    }, input);
    return finalize(ctes, sql`
      SELECT 'task'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.title) AS sort_key, m.title AS title,
             nullif(concat_ws(' · ', nullif(p.name, ''), ${rawSql(label(TASK_STATUS, 'm.status::text'))}), '') AS subtitle,
             array_remove(ARRAY[
               CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END,
               CASE WHEN m.status::text = 'DONE' THEN 'done' END
             ], NULL)::text[] AS badges,
             m.project_id::text || ':task:' || m.id::text AS target
      FROM m LEFT JOIN projects p ON ${tenantOf(input, 'p.business_id')} AND p.id = m.project_id`, input);
  },
};

export const PROJECTS_SEARCH_INDEXES = [
  prefixIndex('projects', 'name'), wordIndex('projects', 'name'),
  prefixIndex('project_tasks', 'title'), wordIndex('project_tasks', 'title'),
];
