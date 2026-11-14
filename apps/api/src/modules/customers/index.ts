// Public API of the customers module (data-model §4.5–4.6). Routes import only from here.
export { archiveCustomer, createCustomer, getCustomer, listCustomers, restoreCustomer, updateCustomer } from './server/customers';
export { archiveContact, createContact, getContact, listContacts, restoreContact, updateContact } from './server/contacts';
