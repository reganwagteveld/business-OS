import type { SearchBadge, SearchType, SearchZone } from '@business-os/contracts';

/** Fixed client labels for the closed badge enum. An unknown value is dropped (GS2 §4.5 rule 3). */
export const BADGE_LABEL: Record<SearchBadge, string> = {
  archived: 'Archived', draft: 'Draft', void: 'Void', former: 'Former', won: 'Won', lost: 'Lost', completed: 'Completed',
  cancelled: 'Cancelled', accepted: 'Accepted', declined: 'Declined', expired: 'Expired', done: 'Done', inactive: 'Inactive',
};

export function badgeLabels(badges: readonly string[]): string[] {
  return badges.flatMap((b) => (Object.hasOwn(BADGE_LABEL, b) ? [BADGE_LABEL[b as SearchBadge]] : []));
}

/** Group headings and fixed display order, matching the sidebar Zone order (GS2 §4.2). */
export const TYPE_ORDER: readonly SearchType[] = ['customer', 'contact', 'opportunity', 'project', 'task', 'quote', 'invoice', 'credit_note', 'catalog_item', 'employee'];

export const TYPE_HEADING: Record<SearchType, string> = {
  customer: 'Customers', contact: 'Contacts', opportunity: 'Sales · Opportunities', project: 'Projects', task: 'Projects · Tasks',
  quote: 'Finance · Quotes', invoice: 'Finance · Invoices', credit_note: 'Finance · Credit notes', catalog_item: 'Finance · Catalog', employee: 'People',
};

export const TYPE_NOUN: Record<SearchType, string> = {
  customer: 'Customer', contact: 'Contact', opportunity: 'Opportunity', project: 'Project', task: 'Task',
  quote: 'Quote', invoice: 'Invoice', credit_note: 'Credit note', catalog_item: 'Catalog item', employee: 'Person',
};

export const ZONE_OF: Record<SearchType, SearchZone> = {
  customer: 'customers', contact: 'customers', opportunity: 'sales', project: 'projects', task: 'projects',
  quote: 'finance', invoice: 'finance', credit_note: 'finance', catalog_item: 'finance', employee: 'people',
};
