// @vitest-environment jsdom
// Communications C1 UI: the unified timeline, type badges, note composer, log-interaction form and
// conversation history on the customer page, through the real client and contracts in front of the
// in-memory fake API. No sample data: everything shown comes from the fake's records.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient } from '../src/api/customers';
import { CustomerZone } from '../src/zones/customers/customer-zone';
import { ActivityTimeline } from '../src/zones/activity/activity-timeline';
import { badgeLabel, messageEntryTitle } from '../src/zones/activity/labels';
import { activity, conversation, createFakeApi, customer, emptyBusiness, message, uuid, type FakeBusiness } from './support/fake-api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ALL = ['business:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write', 'communications:read', 'communications:record'];

function mount(opts: { permissions?: string[]; business?: (acmeId: string) => Partial<FakeBusiness> } = {}) {
  const acme = customer({ displayName: 'Acme' });
  const api = createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme], ...opts.business?.(acme.id) } });
  const client = createCustomersClient('https://api.test', { kind: 'cookie' }, api.fetch);
  const user = userEvent.setup();
  render(
    <CustomerZone client={client} userLabel="Ada" onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} context={{
      business: { slug: 'alpha', name: 'Alpha', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
      membership: { id: uuid(), role: 'MEMBER', permissions: opts.permissions ?? ALL },
    }} />,
  );
  return { api, user, acme };
}
const openAcme = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Acme' }));
  return screen.findByRole('heading', { name: 'Acme', level: 1 });
};
const timeline = () => screen.getByLabelText('Activity');

describe('timeline badges and wording', () => {
  it('labels kinds and directions, and never says Business OS sent a message', () => {
    const at = (over: Parameters<typeof activity>[1]) => activity(null, over);
    expect(badgeLabel(at({ type: 'call', data: { direction: 'OUTBOUND' } }))).toBe('Call · outgoing');
    expect(badgeLabel(at({ type: 'interaction', data: { channel: 'SMS', direction: 'INBOUND' } }))).toBe('SMS · incoming');
    expect(badgeLabel(at({ type: 'message.recorded', data: { channel: 'EMAIL', direction: 'INBOUND', source: 'MANUAL' } }))).toBe('Recorded email · incoming');
    expect(messageEntryTitle(at({ type: 'message.recorded', data: { channel: 'EMAIL', direction: 'OUTBOUND', source: 'MANUAL' } }))).toBe('Recorded email sent outside Business OS');
    expect(messageEntryTitle(at({ type: 'message.recorded', data: { channel: 'CHAT', direction: 'INBOUND', source: 'IMPORT' } }))).toBe('Imported chat received');
  });

  it('shows restricted, edited and recorded-message entries from the API as they are', async () => {
    const { user } = mount({ business: (id) => ({ activities: [
      activity(id, { type: 'note', subject: 'Private', visibility: 'RESTRICTED', editedAt: '2026-11-14T04:00:00.000Z', occurredAt: '2026-11-14T03:00:00.000Z' }),
      activity(id, { type: 'message.recorded', conversationId: uuid(), messageId: uuid(), data: { channel: 'EMAIL', direction: 'OUTBOUND', source: 'IMPORT' }, occurredAt: '2026-11-13T03:00:00.000Z' }),
      activity(id, { type: 'customer.created', occurredAt: '2026-11-12T03:00:00.000Z' }),
    ] }) });
    await openAcme(user);
    const items = await within(timeline()).findAllByRole('listitem');
    expect(items.map((li) => li.querySelector('p')!.textContent)).toEqual(['Private', 'Imported email sent outside Business OS', 'Customer created']);
    expect(within(items[0]!).getByText('Restricted')).toBeTruthy();
    expect(items[0]!.textContent).toContain('edited');
    expect(within(items[1]!).getByRole('img', { name: 'Recorded email · outgoing' })).toBeTruthy();
    expect(screen.queryByText(/sent by Business OS|sent via Business OS/i)).toBeNull();
  });

  it('filters by type on the server and says so when nothing matches; the empty timeline explains how entries appear', async () => {
    const { api, user } = mount();
    await openAcme(user);
    expect(await within(timeline()).findByText('No activity yet.')).toBeTruthy();
    expect(within(timeline()).getByText(/recorded messages and changes to this customer appear here/)).toBeTruthy();
    await user.selectOptions(within(timeline()).getByLabelText('Show'), 'Recorded messages');
    expect(await within(timeline()).findByText('Nothing of this kind yet.')).toBeTruthy();
    await waitFor(() => expect(api.callsTo(/GET .*activities/).some((c) => c.query.types === 'message.recorded')).toBe(true));
  });

  it('an error loading the timeline is reported with a retry, not shown as empty', async () => {
    const onSessionEnded = vi.fn();
    const load = vi.fn().mockResolvedValueOnce({ kind: 'unreachable' }).mockResolvedValue({ kind: 'ok', data: { activities: [], nextCursor: null } });
    render(<ActivityTimeline load={load} loadKey="k" names={null} timeZone="UTC" onSessionEnded={onSessionEnded} />);
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeTruthy();
    expect(screen.queryByText('No activity yet.')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('No activity yet.')).toBeTruthy();
  });
});

describe('note composer and log interaction form', () => {
  it('adds a restricted note; the request carries only the note, never an author', async () => {
    const { api, user, acme } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add note' }));
    const form = screen.getByRole('form', { name: 'Add note' });
    await user.type(within(form).getByLabelText('Note'), 'Do not discuss pricing');
    await user.click(within(form).getByRole('checkbox'));
    await user.click(within(form).getByRole('button', { name: 'Save note' }));
    expect(await screen.findByText('Restricted note saved.')).toBeTruthy();
    expect(api.callsTo(/POST .*activities$/)[0]!.body).toEqual({ customerId: acme.id, type: 'note', body: 'Do not discuss pricing', visibility: 'RESTRICTED' });
    expect(await within(timeline()).findByText('Restricted')).toBeTruthy();
  });

  it('refuses an empty note and keeps the text when the server cannot be reached', async () => {
    const { api, user } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Add note' }));
    const form = screen.getByRole('form', { name: 'Add note' });
    await user.click(within(form).getByRole('button', { name: 'Save note' }));
    expect(within(form).getByRole('alert').textContent).toBe('Write something first.');
    await user.type(within(form).getByLabelText('Note'), 'Still here');
    api.next(() => 'network');
    await user.click(within(form).getByRole('button', { name: 'Save note' }));
    expect(await within(form).findByText(/may or may not have been saved/)).toBeTruthy();
    expect((within(form).getByLabelText('Note') as HTMLTextAreaElement).value).toBe('Still here');
  });

  it('logs an SMS with its channel and direction, and says nothing is sent', async () => {
    const { api, user, acme } = mount();
    await openAcme(user);
    await user.click(await screen.findByRole('button', { name: 'Log activity' }));
    const form = screen.getByRole('form', { name: 'Log activity' });
    await user.click(within(form).getByRole('radio', { name: 'Other' }));
    expect(within(form).getByText(/Nothing is sent/)).toBeTruthy();
    await user.selectOptions(within(form).getByLabelText('Channel'), 'SMS');
    await user.selectOptions(within(form).getByLabelText('Direction'), 'INBOUND');
    await user.type(within(form).getByLabelText('Details'), 'Running 10 minutes late');
    await user.click(within(form).getByRole('button', { name: 'Save activity' }));
    expect(await screen.findByText('Interaction logged.')).toBeTruthy();
    expect(api.callsTo(/POST .*activities$/)[0]!.body).toEqual({ customerId: acme.id, type: 'interaction', subject: null, body: 'Running 10 minutes late', channel: 'SMS', direction: 'INBOUND' });
    expect(await within(timeline()).findByRole('img', { name: 'SMS · incoming' })).toBeTruthy();
  });

  it('without activity:write there are no composers; the timeline still reads', async () => {
    const { user } = mount({ permissions: ['business:read', 'customers:read', 'activity:read'] });
    await openAcme(user);
    expect(await within(timeline()).findByText('No activity yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Log activity' })).toBeNull();
  });
});

describe('conversation history', () => {
  it('opens a conversation to its messages, oldest first, with sender, recipients and how each was recorded', async () => {
    let conv = conversation(null);
    const { user } = mount({ business: (id) => {
      conv = conversation(id, { subject: 'Quote request', lastMessageAt: '2026-10-02T09:00:00.000Z' });
      return {
        conversations: [conv],
        messages: [
          message(conv.id, { direction: 'OUTBOUND', occurredAt: '2026-10-02T09:00:00.000Z', body: 'Quote attached', source: 'IMPORT', externalSource: 'gmail-export',
            participants: [{ role: 'FROM', position: 0, displayName: 'Ada', address: 'ada@us.example', contactId: null, userId: null }, { role: 'TO', position: 0, displayName: null, address: 'pat@client.example', contactId: null, userId: null }] }),
          message(conv.id, { direction: 'INBOUND', occurredAt: '2026-10-01T09:00:00.000Z', subject: 'Hello', body: 'Could you quote?',
            participants: [{ role: 'FROM', position: 0, displayName: 'Pat', address: null, contactId: null, userId: null }] }),
        ],
      };
    } });
    await openAcme(user);
    const panel = screen.getByLabelText('Conversations');
    await user.click(await within(panel).findByRole('button', { name: /Quote request/ }));
    const items = await within(panel).findAllByRole('listitem').then(() => within(within(panel).getByRole('list', { name: 'Messages' })).getAllByRole('listitem'));
    expect(items.map((li) => li.getAttribute('data-direction'))).toEqual(['INBOUND', 'OUTBOUND']);
    expect(items[0]!.textContent).toContain('From Pat');
    expect(items[0]!.textContent).toContain('Recorded');
    expect(items[1]!.textContent).toContain('Sent outside Business OS');
    expect(items[1]!.textContent).toContain('Imported from gmail-export');
    expect(items[1]!.textContent).toContain('to pat@client.example');
  });

  it('says plainly when there are no conversations, and is hidden without communications:read', async () => {
    const first = mount();
    await openAcme(first.user);
    expect(await within(screen.getByLabelText('Conversations')).findByText(/No conversations recorded yet/)).toBeTruthy();
    cleanup();
    const second = mount({ permissions: ['business:read', 'customers:read', 'activity:read', 'activity:write'] });
    await openAcme(second.user);
    await within(timeline()).findByText('No activity yet.');
    expect(screen.queryByLabelText('Conversations')).toBeNull();
    expect(second.api.callsTo(/conversations/)).toHaveLength(0);
  });
});
