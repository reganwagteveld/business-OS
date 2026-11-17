// Public API of the customers module (data-model §4.5–4.6). Routes import only from here.
export { archiveCustomer, createCustomer, customerSummary, getCustomer, listCustomers, restoreCustomer, updateCustomer } from './server/customers';
export { archiveContact, createContact, getContact, listContacts, restoreContact, updateContact } from './server/contacts';
// Reporting R1 (docs/reporting-r1.md §4): the Customers Zone's own reporting read model.
export { customerLabels, newCustomerCounts, newCustomerDetails } from './server/reporting';
export type { CustomerPeriodQuery, CustomerPeriodRow, NewCustomerDetail } from './server/reporting';
// Global search GS1-A (docs/global-search-gs1.md §6.2): this Zone's providers and the indexes they rely on.
export { contactSearchProvider, customerSearchProvider, CUSTOMER_SEARCH_INDEXES } from './server/search';
