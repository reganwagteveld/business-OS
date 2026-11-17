import 'server-only';
// The providers global search combines (docs/global-search-gs1.md §4.1, §6.2). Each lives in the module
// that owns its table and is reached only through that module's public API. Order = the fixed Zone order
// of the sidebar (§9.4), then type order within a Zone.
import type { SearchType } from '@business-os/contracts';
import type { SearchIndex, SearchProvider } from '@/core/search';
import type { Permission } from '@/modules/access';
import { contactSearchProvider, CUSTOMER_SEARCH_INDEXES, customerSearchProvider } from '@/modules/customers';
import {
  catalogItemSearchProvider, creditNoteSearchProvider, FINANCE_SEARCH_INDEXES, invoiceSearchProvider, quoteSearchProvider,
} from '@/modules/finance';
import { employeeSearchProvider, PEOPLE_SEARCH_INDEXES } from '@/modules/people';
import { projectSearchProvider, PROJECTS_SEARCH_INDEXES, taskSearchProvider } from '@/modules/projects';
import { opportunitySearchProvider, SALES_SEARCH_INDEXES } from '@/modules/sales';

export const SEARCH_PROVIDERS: readonly SearchProvider<Permission>[] = [
  customerSearchProvider, contactSearchProvider,
  opportunitySearchProvider,
  projectSearchProvider, taskSearchProvider,
  quoteSearchProvider, invoiceSearchProvider, creditNoteSearchProvider, catalogItemSearchProvider,
  employeeSearchProvider,
];

/** Every index the GS1-A migration creates, in migration order. */
export const SEARCH_INDEXES: readonly SearchIndex[] = [
  ...CUSTOMER_SEARCH_INDEXES, ...SALES_SEARCH_INDEXES, ...PROJECTS_SEARCH_INDEXES, ...FINANCE_SEARCH_INDEXES, ...PEOPLE_SEARCH_INDEXES,
];

export const TYPE_ORDER: readonly SearchType[] = SEARCH_PROVIDERS.map((p) => p.type);
