// Public API of the customers module (data-model §4.5–4.6). Routes import only from here.
export { archiveCustomer, createCustomer, customerSummary, getCustomer, listCustomers, restoreCustomer, updateCustomer } from './server/customers';
export { archiveContact, createContact, getContact, listContacts, restoreContact, updateContact } from './server/contacts';
// Reporting R1 (docs/reporting-r1.md §4): the Customers Zone's own reporting read model.
export { customerLabels, newCustomerCounts, newCustomerDetails } from './server/reporting';
export type { CustomerPeriodQuery, CustomerPeriodRow, NewCustomerDetail } from './server/reporting';
