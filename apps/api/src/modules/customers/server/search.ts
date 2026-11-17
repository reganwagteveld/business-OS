import 'server-only';
// Global search providers for the Customers Zone (docs/global-search-gs1.md §4.1, §6.4, §8). Names and
// work contact fields only: no phone, address, tax number, website, notes or owner is matched or returned.
import { sql } from '@/core/db';
import { candidates, finalize, prefixIndex, tenantOf, wordIndex, type SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';

const CUSTOMER_WORDS = `display_name || ' ' || coalesce(legal_name, '')`;

export const customerSearchProvider: SearchProvider<Permission> = {
  type: 'customer',
  zone: 'customers',
  requires: ['customers:read'],
  matchFields: ['display_name', 'legal_name', 'email'],
  resultFields: ['display_name', 'legal_name', 'email', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'customers', columns: 'id, display_name, legal_name, email, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'display_name', exactTier: 1, prefixTier: 2 }, { column: 'email', exactTier: 1, prefixTier: 4 }],
      words: CUSTOMER_WORDS,
    }, input);
    return finalize(ctes, sql`
      SELECT 'customer'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.display_name) AS sort_key, m.display_name AS title,
             CASE WHEN m.legal_name IS NOT NULL AND m.legal_name <> m.display_name THEN m.legal_name ELSE m.email END AS subtitle,
             array_remove(ARRAY[CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END], NULL)::text[] AS badges,
             m.id::text AS target
      FROM m`, input);
  },
};

export const contactSearchProvider: SearchProvider<Permission> = {
  type: 'contact',
  zone: 'customers',
  requires: ['customers:read'],
  matchFields: ['display_name', 'email'],
  resultFields: ['display_name', 'customer.display_name', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'contacts', columns: 'id, display_name, customer_id, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'display_name', exactTier: 1, prefixTier: 2 }, { column: 'email', exactTier: 1, prefixTier: 4 }],
      words: 'display_name',
    }, input);
    return finalize(ctes, sql`
      SELECT 'contact'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.display_name) AS sort_key, m.display_name AS title, c.display_name AS subtitle,
             array_remove(ARRAY[CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END], NULL)::text[] AS badges,
             'contact:' || m.id::text AS target
      FROM m LEFT JOIN customers c ON ${tenantOf(input, 'c.business_id')} AND c.id = m.customer_id`, input);
  },
};

export const CUSTOMER_SEARCH_INDEXES = [
  prefixIndex('customers', 'display_name'), prefixIndex('customers', 'email'), wordIndex('customers', CUSTOMER_WORDS),
  prefixIndex('contacts', 'display_name'), prefixIndex('contacts', 'email'), wordIndex('contacts', 'display_name'),
];
