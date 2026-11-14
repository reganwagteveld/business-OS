// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient } from '../src/api/customers';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { contact, createFakeApi, customer, emptyBusiness, uuid } from './support/fake-api';

afterEach(cleanup);
const permissions = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write'];
function mount(opts: { canEdit?: boolean; canLog?: boolean } = {}) {
  const initial = customer({ displayName: 'Acme' });
  const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [initial] } });
  const client = createCustomersClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const p = permissions.filter(x => (opts.canEdit !== false || x !== 'customers:write') && (opts.canLog !== false || x !== 'activity:write'));
  const user = userEvent.setup();
  render(<CustomerZone client={client} context={{
    business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
    membership: { id: uuid(), role: 'MANAGER', permissions: p },
  }} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
  return { api, user, initial };
}

describe('PR13 contacts and activity', () => {
  it('creates a contact against the current business and lets the user mark it primary', async () => {
    const { api, user, initial } = mount();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Alice');
    await user.click(screen.getByRole('button', { name: 'Save contact' }));
    expect(await screen.findByText('Alice')).toBeTruthy();
    expect(api.businesses.alpha!.contacts[0]!.customerId).toBe(initial.id);
    await user.click(screen.getByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(initial.primaryContactId).toBe(api.businesses.alpha!.contacts[0]!.id));
  });

  it('logs an activity using the validated endpoint', async () => {
    const { api, user, initial } = mount();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    await user.type(screen.getByRole('textbox', { name: 'Subject' }), 'Discussed proposal');
    await user.click(screen.getByRole('button', { name: 'Save activity' }));
    await waitFor(() => expect(api.businesses.alpha!.activities.some(a => a.subject === 'Discussed proposal' && a.customerId === initial.id)).toBe(true));
  });

  it('hides mutation controls without the corresponding permission', async () => {
    const { user } = mount({ canEdit: false, canLog: false });
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    expect(screen.queryByRole('button', { name: 'Add contact' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log activity' })).toBeNull();
  });
});
