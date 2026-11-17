import 'server-only';
// Global search providers for the Finance Zone (docs/global-search-gs1.md §4.1, §8, §9.2). Quotes,
// invoices and credit notes by number or by their customer's name; catalog items by name or code.
// Never an amount, line, note, bill-to address or price: the palette is often on screen in calls (§6.4).
// The customer name is shown to finance:read, as the Finance lists already do (§6.3).
import type { SearchType } from '@business-os/contracts';
import { rawSql, sql } from '@/core/db';
import { candidates, finalize, prefixIndex, tenantOf, wordIndex, type SearchIndex, type SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';

const KINDS = { quote: ['QUOTE', 'quote', 'Draft quote'], invoice: ['INVOICE', 'invoice', 'Draft invoice'], credit_note: ['CREDIT_NOTE', 'credit-note', 'Draft credit note'] } as const;
const DOC_COLUMNS = ['id', 'number', 'status', 'customer_id', 'issue_date', 'due_date'];

function documentProvider(type: 'quote' | 'invoice' | 'credit_note'): SearchProvider<Permission> {
  const [kind, targetPrefix, draftTitle] = KINDS[type];
  return {
    type,
    zone: 'finance',
    requires: ['finance:read'],
    matchFields: ['number', 'customer.display_name'],
    resultFields: ['number', 'status', 'customer.display_name', type === 'invoice' ? 'due_date (else issue_date)' : 'issue_date'],
    branch(input) {
      const extra = [];
      if (input.mode === 'text') {
        const { q } = input.query;
        // Through the customer's name: the customers prefix index, then the documents of each customer (§9.2).
        extra.push(sql`SELECT * FROM (SELECT ${rawSql(DOC_COLUMNS.map((c) => `d.${c}`).join(', '))}, 3 AS tier
          FROM customers c
          JOIN finance_documents d ON d.business_id = c.business_id AND d.customer_id = c.id AND d.kind = ${kind}::"FinanceDocumentKind"
          WHERE ${tenantOf(input, 'c.business_id')}
            AND lower(c.display_name) COLLATE "C" >= lower(${q}) COLLATE "C"
            AND lower(c.display_name) COLLATE "C" < (lower(${q}) || chr(1114111)) COLLATE "C"
          ORDER BY lower(c.display_name) COLLATE "C", d.id
          LIMIT ${input.prefixCap}) f`);
      }
      const ctes = candidates({
        table: 'finance_documents', columns: DOC_COLUMNS.join(', '), live: 'TRUE', scope: `kind = '${kind}'`,
        arms: [{ column: 'number', exactTier: 1, prefixTier: 2 }],
      }, input, extra);
      const date = type === 'invoice' ? sql`coalesce(m.due_date, m.issue_date)` : sql`m.issue_date`;
      return finalize(ctes, sql`
        SELECT ${type}::text AS type, m.id, m.tier, 0 AS demote,
               coalesce(lower(m.number), '') AS sort_key, coalesce(m.number, ${draftTitle}::text) AS title,
               nullif(concat_ws(' · ', nullif(c.display_name, ''), to_char(${date}, 'YYYY-MM-DD')), '') AS subtitle,
               array_remove(ARRAY[CASE m.status::text WHEN 'DRAFT' THEN 'draft' WHEN 'VOID' THEN 'void' WHEN 'ACCEPTED' THEN 'accepted'
                 WHEN 'DECLINED' THEN 'declined' WHEN 'EXPIRED' THEN 'expired' END], NULL)::text[] AS badges,
               ${targetPrefix}::text || ':' || m.id::text AS target
        FROM m LEFT JOIN customers c ON ${tenantOf(input, 'c.business_id')} AND c.id = m.customer_id`, input);
    },
  };
}

export const quoteSearchProvider = documentProvider('quote');
export const invoiceSearchProvider = documentProvider('invoice');
export const creditNoteSearchProvider = documentProvider('credit_note');

export const catalogItemSearchProvider: SearchProvider<Permission> = {
  type: 'catalog_item' satisfies SearchType,
  zone: 'finance',
  requires: ['finance:read'],
  matchFields: ['name', 'code'],
  resultFields: ['name', 'code', 'type', 'status', 'archived_at'],
  branch(input) {
    const ctes = candidates({
      table: 'finance_catalog_items', columns: 'id, name, code, type, status, archived_at', live: 'archived_at IS NULL',
      arms: [{ column: 'name', exactTier: 1, prefixTier: 2 }, { column: 'code', exactTier: 1, prefixTier: 4 }],
      words: 'name',
    }, input);
    return finalize(ctes, sql`
      SELECT 'catalog_item'::text AS type, m.id, m.tier, CASE WHEN m.archived_at IS NULL THEN 0 ELSE 2 END AS demote,
             lower(m.name) AS sort_key, m.name AS title,
             nullif(concat_ws(' · ', nullif(m.code, ''), CASE m.type WHEN 'PRODUCT' THEN 'Product' WHEN 'SERVICE' THEN 'Service' END), '') AS subtitle,
             array_remove(ARRAY[
               CASE WHEN m.archived_at IS NOT NULL THEN 'archived' END,
               CASE WHEN m.archived_at IS NULL AND m.status <> 'ACTIVE' THEN 'inactive' END
             ], NULL)::text[] AS badges,
             'catalog:' || m.id::text AS target
      FROM m`, input);
  },
};

const documentNumberIndex: SearchIndex = {
  name: 'finance_documents_search_number_idx',
  table: 'finance_documents',
  statement: 'CREATE INDEX "finance_documents_search_number_idx" ON "finance_documents" ("business_id", "kind", (lower("number") COLLATE "C"), "id");',
};

export const FINANCE_SEARCH_INDEXES = [
  documentNumberIndex,
  prefixIndex('finance_catalog_items', 'name'), prefixIndex('finance_catalog_items', 'code'), wordIndex('finance_catalog_items', 'name'),
];
