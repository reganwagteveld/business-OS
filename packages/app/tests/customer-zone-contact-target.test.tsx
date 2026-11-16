// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient } from '../src/api/customers';
import { CustomerZone, customerTarget } from '../src/zones/customers/customer-zone';
import { contact, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'];

// GS2-A: the `contact:<id>` target (GS1 §10.6) that a search result will open.
function mount(contactId: string, opts: { alpha?: Partial<FakeBusiness>; beta?: Partial<FakeBusiness>; permissions?: string[]; before?: (api: ReturnType<typeof createFakeApi>) => void } = {}) {
  const api = createFakeApi({ alpha: { ...emptyBusiness(), ...opts.alpha }, beta: { ...emptyBusiness(), ...opts.beta } });
  opts.before?.(api);
  const client = createCustomersClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  render(
    <CustomerZone client={client} userLabel="Ada" {...handlers} initialContactId={contactId} context={{
      business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
      membership: { id: uuid(), role: 'MANAGER', permissions: opts.permissions ?? ALL },
    }} />,
  );
  return { api };
}
const contactsPanel = () => screen.getByLabelText('Contacts');

describe('customerTarget', () => {
  it('reads contact:<id> as a contact and anything else as a customer id', () => {
    const id = uuid();
    expect(customerTarget(`contact:${id}`)).toEqual({ contactId: id });
    expect(customerTarget(id)).toEqual({ customerId: id });
    expect(customerTarget(undefined)).toEqual({});
  });
});

describe('opening a contact', () => {
  it("opens the contact's customer with that contact marked, asking only this business", async () => {
    const acme = customer({ displayName: 'Acme' });
    const amy = contact(acme.id, { displayName: 'Amy' });
    const zed = contact(acme.id, { displayName: 'Zed' });
    const { api } = mount(zed.id, { alpha: { customers: [acme], contacts: [amy, zed] } });
    expect(await screen.findByRole('heading', { name: 'Acme', level: 1 })).toBeTruthy();
    await waitFor(() => expect(within(contactsPanel()).getAllByRole('listitem').length).toBe(2));
    const marked = within(contactsPanel()).getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'true');
    expect(marked.map((li) => li.textContent)).toEqual([expect.stringMatching(/^Zed/)]);
    expect(api.callsTo(/GET .*contacts\/[^/]+$/).map((c) => c.slug)).toEqual(['alpha']);
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['alpha']));
  });

  it('opens the archived list when the contact is archived, and marks it there', async () => {
    const acme = customer({ displayName: 'Acme' });
    const old = contact(acme.id, { displayName: 'Old Contact', archivedAt: '2026-01-01T00:00:00.000Z' });
    mount(old.id, { alpha: { customers: [acme], contacts: [old] } });
    const archived = await screen.findByRole('list', { name: 'Archived contacts' });
    expect(screen.getByRole('button', { name: 'Hide archived contacts' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(archived).getByRole('listitem').getAttribute('aria-current')).toBe('true');
  });

  it('shows a read-only page for a contact with no customer, and never loads a customer', async () => {
    const solo = contact(null, { displayName: 'Solo Person', email: 'solo@example.test', jobTitle: 'Buyer', notes: 'Private note' });
    const { api } = mount(solo.id, { alpha: { contacts: [solo] } });
    expect(await screen.findByRole('heading', { name: 'Solo Person', level: 1 })).toBeTruthy();
    expect(screen.getByText('This contact is not linked to a customer.')).toBeTruthy();
    expect(screen.getByText('Buyer')).toBeTruthy();
    expect(screen.queryByText('Private note')).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit|Archive/ })).toBeNull();
    expect(api.callsTo(/customers/).length).toBe(0);
  });

  it("shows not found for a contact in another business, and nothing of that business's data", async () => {
    const secret = contact(null, { displayName: 'Beta Secret' });
    mount(secret.id, { beta: { contacts: [secret] } });
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
    expect(screen.queryByText('Beta Secret')).toBeNull();
  });

  it('treats a malformed id as not found without sending a request', async () => {
    const { api } = mount('../customers');
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
    expect(api.callsTo(/contacts/).length).toBe(0);
  });

  it('shows the access problem when the server refuses the contact', async () => {
    const acme = customer({ displayName: 'Acme' });
    const amy = contact(acme.id, { displayName: 'Amy' });
    mount(amy.id, { alpha: { customers: [acme], contacts: [amy] }, before: (api) => api.next(() => new Response('{"error":"forbidden"}', { status: 403 })) });
    expect(await screen.findByRole('heading', { name: 'You do not have access' })).toBeTruthy();
    expect(screen.queryByText('Acme')).toBeNull();
  });

  it('fails gracefully when the contact moves between the contact read and the customer read', async () => {
    const acme = customer({ displayName: 'Acme' });
    const other = customer({ displayName: 'Other' });
    const amy = contact(acme.id, { displayName: 'Amy' });
    const { api } = mount(amy.id, { alpha: { customers: [acme, other], contacts: [amy] } });
    // Moved away as soon as the contact itself has been read: Acme's list no longer holds it.
    await waitFor(() => expect(api.callsTo(/GET .*contacts\/[^/]+$/).length).toBe(1));
    amy.customerId = other.id;
    expect(await screen.findByRole('heading', { name: 'Acme', level: 1 })).toBeTruthy();
    expect(await within(contactsPanel()).findByText('No contacts are linked to this customer yet.')).toBeTruthy();
    expect(contactsPanel().querySelector('[aria-current]')).toBeNull();
  });

  it("shows the customer's not-found state when the customer is gone by the time it is read", async () => {
    const amy = contact(uuid(), { displayName: 'Amy' }); // points at a customer that does not exist
    mount(amy.id, { alpha: { contacts: [amy] } });
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeTruthy();
    expect(screen.getByText(/This customer could not be found/)).toBeTruthy();
  });
});
