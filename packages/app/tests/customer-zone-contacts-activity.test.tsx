// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '@business-os/contracts';
import { createCustomersClient, MAX_CONTACT_PAGES } from '../src/api/customers';
import { toInstant } from '../src/zones/customers/activity-composer';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { activity, contact, createFakeApi, customer, emptyBusiness, uuid, type FakeBusiness } from './support/fake-api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'];

function mount(opts: { permissions?: string[]; business?: Partial<FakeBusiness>; customerOver?: Parameters<typeof customer>[0] } = {}) {
  const acme = customer({ displayName: 'Acme', ...opts.customerOver });
  const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], ...opts.business }, beta: { ...emptyBusiness(), customers: [customer({ displayName: 'Beta Secret' })] } });
  const client = createCustomersClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn() };
  const user = userEvent.setup();
  render(
    <CustomerZone client={client} userLabel="Ada" {...handlers} context={{
      business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
      membership: { id: uuid(), role: 'MANAGER', permissions: opts.permissions ?? ALL },
    }} />,
  );
  return { api, user, acme, handlers };
}
const openAcme = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Acme' }));
  return screen.findByRole('heading', { name: 'Acme', level: 1 });
};
const contactsPanel = () => screen.getByLabelText('Contacts');
// The page also has "Details" and "Notes" panels, so fields are found inside their own form.
const composer = () => screen.getByRole('form', { name: 'Log activity' });

describe('contacts', () => {
  it('adds a contact to this customer in this business only; the name comes from first and last name', async () => {
    const { api, user, acme } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText('First name'), 'Alice');
    await user.type(screen.getByLabelText('Last name'), 'Nguyen');
    await user.type(screen.getByLabelText('Email'), 'Alice@Acme.example');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Alice Nguyen added.')).toBeTruthy();
    const post = api.callsTo(/POST .*contacts$/)[0]!;
    expect(post.slug).toBe('alpha');
    expect(post.body).toEqual({ firstName: 'Alice', lastName: 'Nguyen', email: 'alice@acme.example', customerId: acme.id });
    expect(JSON.stringify(api.calls.map((c) => [c.query, c.body]))).not.toMatch(/business/i);
    expect(new Set(api.calls.map((c) => c.slug))).toEqual(new Set(['alpha']));
    expect(within(contactsPanel()).getByText('Alice Nguyen')).toBeTruthy();
    expect(api.businesses.beta!.contacts).toHaveLength(0);
  });

  it('refuses an empty contact before sending, and shows server validation without losing the draft', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(screen.getByRole('alert').textContent).toMatch(/name or an email/);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(screen.getByLabelText('First name').getAttribute('aria-invalid')).toBe('true');
    expect(api.callsTo(/POST/).length).toBe(0);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect((await screen.findAllByText('Enter a valid email address')).length).toBeGreaterThan(0); // the shared contract, before anything is sent
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
    expect(api.callsTo(/POST/).length).toBe(0);
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('First name'), 'Bob');
    api.next(() => new Response('{"error":"internal_error"}', { status: 500 }));
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText(/Nothing was changed/)).toBeTruthy();
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Bob');
  });

  it('edits send only changed fields; clearing a typed display name lets the server derive it again', async () => {
    const ada = contact(null, { displayName: 'Accounts desk', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@acme.example' });
    const { api, user, acme } = mount({ business: { contacts: [] } });
    ada.customerId = acme.id;
    api.businesses.alpha!.contacts.push(ada);
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Edit: Accounts desk' }));
    await user.type(screen.getByLabelText('Job title'), 'Director');
    await user.clear(screen.getByLabelText('Display name (optional)'));
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Ada Lovelace updated.')).toBeTruthy();
    expect(api.callsTo(/PATCH .*contacts/)[0]!.body).toEqual({ jobTitle: 'Director', displayName: null });
  });

  it('makes a contact primary through the customer, and the page refreshes in place', async () => {
    const { api, user, acme } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }), contact(acme.id, { displayName: 'Amy' }));
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Make primary: Zed' }));
    expect(await screen.findByText('Zed is now the primary contact.')).toBeTruthy();
    expect(api.callsTo(/PATCH .*customers/)[0]!.body).toEqual({ primaryContactId: api.businesses.alpha!.contacts[0]!.id });
    await waitFor(() => expect(within(contactsPanel()).getAllByRole('listitem')[0]!.textContent).toMatch(/^Zed/)); // primary first, though Amy sorts earlier
    expect(within(contactsPanel()).getByLabelText('Primary contact')).toBeTruthy();
  });

  it('loads every page of contacts, so a primary contact beyond the first 100 is still shown first', async () => {
    const { api, user, acme } = mount();
    const many: Contact[] = Array.from({ length: 140 }, (_, i) => contact(acme.id, { displayName: `Person ${String(i).padStart(3, '0')}` }));
    api.businesses.alpha!.contacts.push(...many);
    acme.primaryContactId = many[139]!.id; // sorts last, on the second page
    await openAcme(user);
    await waitFor(() => expect(within(contactsPanel()).getAllByRole('listitem').length).toBe(140));
    expect(within(contactsPanel()).getAllByRole('listitem')[0]!.textContent).toMatch(/^Person 139/);
    expect(api.callsTo(/GET .*contacts$/).filter((c) => c.query.status === 'active').length).toBe(2);
  });

  it('a list longer than the panel loads is reported as an error, never shown partially', async () => {
    // A server that always has another page: the client stops at its limit and says so.
    let calls = 0;
    const endless = (async (input: RequestInfo | URL) => {
      calls++;
      const url = new URL(String(input));
      return new Response(JSON.stringify({ contacts: [contact(url.searchParams.get('customerId'), { displayName: `Page ${calls}` })], nextCursor: `more${calls}` }), { status: 200 });
    }) as typeof fetch;
    const client = createCustomersClient('https://api.test', { kind: 'cookie' }, endless);
    const outcome = await client.contacts('alpha', uuid());
    expect(outcome.kind).toBe('incomplete');
    expect(calls).toBe(MAX_CONTACT_PAGES);

    // In the panel: an explanation and no rows.
    const { api, user, acme } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Visible?' }));
    const real = api.fetch;
    api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/contacts') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ contacts: [contact(acme.id, { displayName: 'Partial row' })], nextCursor: 'again' }), { status: 200 });
      }
      return real(input, init);
    }) as typeof fetch;
    cleanup();
    const client2 = createCustomersClient('https://api.test', { kind: 'cookie' }, api.fetch);
    render(<CustomerZone client={client2} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} context={{
      business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
      membership: { id: uuid(), role: 'MANAGER', permissions: ALL },
    }} />);
    await openAcme(user);
    expect(await within(contactsPanel()).findByText('Too many to show here')).toBeTruthy();
    expect(within(contactsPanel()).queryByText('Partial row')).toBeNull();
    expect(within(contactsPanel()).queryByRole('listitem')).toBeNull();
  });

  it('after a failed refresh the old rows disappear and only the error shows, so nobody acts on stale contacts', async () => {
    const { api, user, acme } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }), contact(acme.id, { displayName: 'Amy' }));
    await openAcme(user);
    await within(contactsPanel()).findByText('Zed');
    // Archiving succeeds, then the contacts refresh fails.
    api.failNext(/^GET .*\/contacts$/, () => new Response('{"error":"internal_error"}', { status: 500 }));
    await user.click(screen.getByRole('button', { name: 'Archive: Amy' }));
    await user.click(screen.getByRole('button', { name: 'Archive contact' }));
    expect(await within(contactsPanel()).findByText('Something went wrong')).toBeTruthy();
    expect(within(contactsPanel()).queryByText('Zed')).toBeNull();
    expect(within(contactsPanel()).queryByRole('button', { name: /Make primary|Edit:|Archive:/ })).toBeNull();
    // Retrying shows the current list again.
    await user.click(within(contactsPanel()).getByRole('button', { name: 'Try again' }));
    expect(await within(contactsPanel()).findByText('Zed')).toBeTruthy();
    expect(within(contactsPanel()).queryByText('Amy')).toBeNull();
  });

  it('while a refresh is in flight the last good list stays visible, then updates', async () => {
    const { api, user, acme } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }), contact(acme.id, { displayName: 'Amy' }));
    await openAcme(user);
    await within(contactsPanel()).findByText('Amy');
    const release = api.holdNext(/^GET .*\/contacts$/);
    await user.click(screen.getByRole('button', { name: 'Archive: Amy' }));
    await user.click(screen.getByRole('button', { name: 'Archive contact' }));
    await screen.findByText('Amy archived.');
    expect(within(contactsPanel()).getByText('Zed')).toBeTruthy(); // still the last good list, no skeleton flash
    expect(within(contactsPanel()).queryByRole('alert')).toBeNull();
    release();
    await waitFor(() => expect(within(contactsPanel()).queryByText('Amy')).toBeNull());
    expect(within(contactsPanel()).getByText('Zed')).toBeTruthy();
  });

  it('archives after a labelled confirmation (clearing a primary), and archived contacts can be restored', async () => {
    const { api, user, acme } = mount();
    const zed = contact(acme.id, { displayName: 'Zed' });
    api.businesses.alpha!.contacts.push(zed);
    acme.primaryContactId = zed.id;
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Archive: Zed' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Archive Zed?' });
    expect(dialog.textContent).toMatch(/no primary contact/);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep' }));
    await user.click(within(dialog).getByRole('button', { name: 'Archive contact' }));
    expect(await screen.findByText('Zed archived.')).toBeTruthy();
    expect(acme.primaryContactId).toBeNull();
    expect(await within(contactsPanel()).findByText(/No contacts are linked/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show archived contacts' }));
    await user.click(await screen.findByRole('button', { name: 'Restore: Zed' }));
    expect(await screen.findByText('Zed restored.')).toBeTruthy();
    await waitFor(() => expect(within(contactsPanel()).getAllByRole('listitem').some((li) => li.textContent?.startsWith('Zed'))).toBe(true));
    expect(zed.archivedAt).toBeNull();
  });

  it('a double click sends one request', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText('First name'), 'Once');
    const release = api.hold();
    const form = screen.getByLabelText('First name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    expect(await screen.findByText('Once added.')).toBeTruthy();
    expect(api.callsTo(/POST .*contacts$/).length).toBe(1);
  });

  it('an unanswered save is reported as "may have been saved", the list is refreshed, and the draft stays', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText('First name'), 'Maybe');
    const before = api.callsTo(/GET .*contacts$/).length;
    api.next(() => 'network');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText(/may or may not have been saved/)).toBeTruthy();
    expect(screen.queryByText(/added\./)).toBeNull();
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Maybe');
    await waitFor(() => expect(api.callsTo(/GET .*contacts$/).length).toBeGreaterThan(before));
  });
});

describe('activity', () => {
  it('logs a call with a chosen time, attributed by the server, and the timeline shows it', async () => {
    const { api, user, acme } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.click(screen.getByRole('radio', { name: 'Call' }));
    await user.type(screen.getByLabelText('Subject'), 'Discussed proposal');
    await user.type(within(composer()).getByLabelText('Details'), 'Will send a quote.');
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2026-11-10T09:30' } });
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText('Call logged.')).toBeTruthy();
    const body = api.callsTo(/POST .*activities$/)[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ customerId: acme.id, type: 'call', subject: 'Discussed proposal', body: 'Will send a quote.', occurredAt: toInstant('2026-11-10T09:30') });
    expect(body).not.toHaveProperty('actorUserId');
    expect(await within(screen.getByLabelText('Activity')).findByText('Discussed proposal')).toBeTruthy();
  });

  it('leaving the time blank means now; the server decides', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(within(composer()).getByLabelText('Details'), 'Quick note');
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    await screen.findByText('Note logged.');
    expect(api.callsTo(/POST .*activities$/)[0]!.body).not.toHaveProperty('occurredAt');
  });

  it('refuses an empty entry, shows the server date rule, and keeps the text on any failure', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    expect(screen.getByRole('alert').textContent).toBe('Add a subject or some details.');
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(api.callsTo(/POST/).length).toBe(0);
    await user.type(screen.getByLabelText('Subject'), 'Far away');
    fireEvent.change(screen.getByLabelText('When'), { target: { value: '2099-01-01T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText('The date is too far in the future.')).toBeTruthy();
    expect(screen.getByLabelText('When').getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Far away');
  });

  it('an unanswered save refreshes the timeline and does not claim success', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Lost?');
    const before = api.callsTo(/GET .*activities/).length;
    api.next(() => 'network');
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText(/may or may not have been logged/)).toBeTruthy();
    expect(screen.queryByText(/logged\.$/)).toBeNull();
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Lost?');
    await waitFor(() => expect(api.callsTo(/GET .*activities/).length).toBeGreaterThan(before));
  });

  it('a double click logs once', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Once');
    const release = api.hold();
    const form = screen.getByLabelText('Subject').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    release();
    await screen.findByText('Note logged.');
    expect(api.callsTo(/POST .*activities$/).length).toBe(1);
  });

  it('existing history stays newest first after logging', async () => {
    const { api, user, acme } = mount();
    api.businesses.alpha!.activities.push(activity(acme.id, { type: 'note', subject: 'Older note', occurredAt: '2026-01-01T00:00:00.000Z' }));
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Newest');
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    await screen.findByText('Note logged.');
    await waitFor(() => {
      const titles = within(screen.getByLabelText('Activity')).getAllByRole('listitem').map((li) => li.querySelector('p')!.textContent);
      expect(titles).toEqual(['Newest', 'Older note']);
    });
  });
});

describe('unsaved drafts are never dropped silently', () => {
  it('an open contact form: Cancel, All customers, All Zones and closing the window all ask first', async () => {
    const { user, handlers } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText('First name'), 'Draft');
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    for (const leave of [/All customers/, /All Zones/]) {
      await user.click(screen.getByRole('button', { name: leave }));
      await user.click(within(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Keep editing' }));
      expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Draft');
    }
    expect(handlers.onHome).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByLabelText('First name')).toBeNull();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('an open activity draft survives a primary-contact change and asks before switching business', async () => {
    const { api, user, acme, handlers } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }));
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Half written');
    await user.click(await screen.findByRole('button', { name: 'Make primary: Zed' }));
    await screen.findByText('Zed is now the primary contact.');
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Half written'); // refreshed in place, not remounted
    await user.click(screen.getByRole('button', { name: /Switch business/ }));
    expect(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    expect(handlers.onSwitch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(handlers.onSwitch).toHaveBeenCalled();
  });

  it('archiving the customer asks first when a draft is open', async () => {
    const { user, acme } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Unsaved');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('button', { name: 'Archive customer' }));
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' })).getByRole('button', { name: 'Keep editing' }));
    expect(acme.archivedAt).toBeNull();
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Unsaved');
  });
});

describe('permissions and archived customers', () => {
  const controls = () => ({
    addContact: screen.queryByRole('button', { name: 'Add contact' }),
    logActivity: screen.queryByRole('button', { name: 'Log activity' }),
  });

  it.each([
    ['customers:write and activity:write', ALL, { addContact: true, logActivity: true }],
    ['customers:write only', ALL.filter((p) => p !== 'activity:write'), { addContact: true, logActivity: false }],
    ['activity:write only', ALL.filter((p) => p !== 'customers:write'), { addContact: false, logActivity: true }],
    ['read only', ALL.filter((p) => !p.endsWith(':write')), { addContact: false, logActivity: false }],
  ])('%s', async (_, permissions, expected) => {
    const { user, acme, api } = mount({ permissions });
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }));
    await openAcme(user);
    await within(contactsPanel()).findByText('Zed');
    const found = controls();
    expect(Boolean(found.addContact)).toBe(expected.addContact);
    expect(Boolean(found.logActivity)).toBe(expected.logActivity);
    expect(Boolean(screen.queryByRole('button', { name: 'Edit: Zed' }))).toBe(expected.addContact);
  });

  it('an archived customer shows contacts and history read-only', async () => {
    const { user, acme, api } = mount({ customerOver: { archivedAt: '2026-11-01T00:00:00.000Z' } });
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }));
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    await openAcme(user);
    await within(contactsPanel()).findByText('Zed');
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit: Zed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log activity' })).toBeNull();
  });

  it('if the server refuses (role changed meanwhile), the reason is shown and the draft kept', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByLabelText('Subject'), 'Kept');
    api.next(() => new Response('{"error":"forbidden"}', { status: 403 }));
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText(/does not allow logging activity/)).toBeTruthy();
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('Kept');
  });

  it('an ended session hands control back to the app', async () => {
    const { api, user, handlers } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByLabelText('First name'), 'Late');
    api.next(() => new Response('{"error":"unauthenticated"}', { status: 401 }));
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    await waitFor(() => expect(handlers.onSessionEnded).toHaveBeenCalled());
  });
});

describe('accessibility and narrow windows', () => {
  it('every contact and activity control is labelled, and focus can reach all of them by keyboard', async () => {
    const { user, acme, api } = mount();
    api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }));
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    const form = screen.getByRole('form', { name: 'Add contact' });
    for (const label of ['First name', 'Last name', 'Email', 'Phone', 'Mobile', 'Job title', 'Notes', 'Display name (optional)']) {
      const field = within(form).getByLabelText(label);
      field.focus();
      expect(document.activeElement).toBe(field);
    }
    expect(screen.getByLabelText('Display name (optional)').getAttribute('aria-describedby')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Log activity' }));
    expect(screen.getByRole('radiogroup', { name: 'Activity type' })).toBeTruthy();
    screen.getByRole('radio', { name: 'Note' }).focus();
    await user.keyboard('{ArrowRight}');
    expect((screen.getByRole('radio', { name: 'Call' }) as HTMLInputElement).checked).toBe(true);
    for (const label of ['Subject', 'When', 'Details']) expect(within(composer()).getByLabelText(label)).toBeTruthy();
  });

  it('works at a narrow window width (compact layout), with every action still reachable', async () => {
    const queries = new Set<() => void>();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (q: string) => ({ media: q, matches: 375 >= Number(/(\d+)px/.exec(q)![1]), addEventListener: (_: string, cb: () => void) => queries.add(cb), removeEventListener: () => {} }),
    });
    try {
      const { user, acme, api } = mount();
      api.businesses.alpha!.contacts.push(contact(acme.id, { displayName: 'Zed' }));
      await user.click(await screen.findByRole('button', { name: /Acme/ }));
      for (const name of ['Add contact', 'Log activity', 'Edit: Zed', 'Make primary: Zed', 'Archive: Zed', 'Show archived contacts']) {
        expect(await screen.findByRole('button', { name })).toBeTruthy();
      }
    } finally {
      // @ts-expect-error restore jsdom's default
      delete window.matchMedia;
      await act(async () => {});
    }
  });
});
