import 'server-only';
// Global search provider for the Sales Zone (docs/global-search-gs1.md §4.1, §8): opportunities by
// title. Never the amount, probability, owner or description. The customer name appears only for a
// caller who can read customers (§6.3), as on the board.
import { sql } from '@/core/db';
import { candidates, finalize, prefixIndex, tenantOf, wordIndex, type SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';

export const opportunitySearchProvider: SearchProvider<Permission> = {
  type: 'opportunity',
  zone: 'sales',
  requires: ['sales:read'],
  matchFields: ['title'],
  resultFields: ['title', 'status', 'stage.name', 'customer.display_name (customers:read only)', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'opportunities', columns: 'id, title, status, stage_id, customer_id, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'title', exactTier: 1, prefixTier: 2 }],
      words: 'title',
    }, input);
    const customer = input.canReadCustomers ? sql`c.display_name` : sql`NULL::text`;
    return finalize(ctes, sql`
      SELECT 'opportunity'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.title) AS sort_key, m.title AS title,
             nullif(concat_ws(' · ', nullif(${customer}, ''), nullif(s.name, '')), '') AS subtitle,
             array_remove(ARRAY[
               CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END,
               CASE m.status::text WHEN 'WON' THEN 'won' WHEN 'LOST' THEN 'lost' END
             ], NULL)::text[] AS badges,
             m.id::text AS target
      FROM m
      LEFT JOIN sales_stages s ON ${tenantOf(input, 's.business_id')} AND s.id = m.stage_id
      LEFT JOIN customers c ON ${tenantOf(input, 'c.business_id')} AND c.id = m.customer_id`, input);
  },
};

export const SALES_SEARCH_INDEXES = [prefixIndex('opportunities', 'title'), wordIndex('opportunities', 'title')];
