// @vitest-environment jsdom
// LC-2 (docs/customer-lifecycle-audit-wf2.md AC-2.1..2.4): project and opportunity pickers on Finance forms,
// the opportunity's "Quotes and invoices" panel, link chips and the specific link-rule messages. Everything runs
// the real clients and contracts against in-memory APIs that enforce the server's customer rules.
import type { ExpenseCategory } from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, createProjectsClient, createSalesClient, type BusinessContext } from '../src';
import { FinanceZone } from '../src/zones/finance/finance-zone';
import { linkErrorMessage } from '../src/zones/link-errors';
import { ProjectsZone } from '../src/zones/projects/projects-zone';
import { SalesZone } from '../src/zones/sales/sales-zone';
import { createFakeApi, customer, emptyBusiness, uuid } from './support/fake-api';
import { createFakeFinance, doc, financeData, issued, NOW } from './support/fake-finance';
import { emptyProjects, project, withProjects } from './support/fake-projects';
import { emptySales, opportunity, pipelineWithStages, withSales } from './support/fake-sales';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE = 'https://api.test';
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const FULL = ['finance:read', 'finance:write', 'finance:issue', 'finance:expenses', 'customers:read', 'sales:read', 'projects:read'];
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

const acme = customer({ displayName: 'Acme Pty Ltd' });
const beta = customer({ displayName: 'Beta Builders' });
const pipeline = pipelineWithStages();
const fitout = opportunity(pipeline, { title: 'Acme fit-out', customerId: acme.id, currencyCode: 'USD', contactId: randomUUID() });
const wonOpp = opportunity(pipeline, { title: 'Acme service plan', customerId: acme.id, status: 'WON' });
const lostOpp = opportunity(pipeline, { title: 'Acme lost deal', customerId: acme.id, status: 'LOST' });
const betaOpp = opportunity(pipeline, { title: 'Beta bathroom', customerId: beta.id });
const anyOpp = opportunity(pipeline, { title: 'Customerless lead', customerId: null });
const acmeProject = project({ name: 'Acme site works', customerId: acme.id, status: 'ACTIVE' });
const betaProject = project({ name: 'Beta renovation', customerId: beta.id, status: 'ACTIVE' });

const category: ExpenseCategory = { id: randomUUID(), name: 'Materials', position: 10, systemKey: null, archivedAt: null, version: 1, createdAt: NOW, updatedAt: NOW };

function setup(o: {
  permissions?: string[]; section?: string; target?: string; intent?: 'new'; documents?: ReturnType<typeof doc>[]; hideSales?: boolean; hideProjects?: boolean;
  opportunities?: ReturnType<typeof opportunity>[];
} = {}) {
  const permissions = o.permissions ?? FULL;
  const links = {
    opportunities: [fitout, wonOpp, lostOpp, betaOpp, anyOpp].map((x) => ({ id: x.id, customerId: x.customerId })),
    projects: [acmeProject, betaProject].map((x) => ({ id: x.id, customerId: x.customerId })),
  };
  const fin = createFakeFinance({ alpha: financeData({ customers: [acme, beta], documents: o.documents ?? [], links, categories: [category] }) });
  const biz = { ...emptyBusiness(), customers: [acme, beta] };
  const other = withProjects(withSales(createFakeApi({ alpha: biz }), { alpha: { ...emptySales(), pipelines: [pipeline], opportunities: o.opportunities ?? [fitout, wonOpp, lostOpp, betaOpp, anyOpp] } }),
    { alpha: { ...emptyProjects(), projects: [acmeProject, betaProject] } });
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn(), onOpenCustomer: vi.fn(), onOpenOpportunity: vi.fn(), onOpenProject: vi.fn() };
  render(
    <FinanceZone key="alpha" client={createFinanceClient(BASE, { kind: 'cookie' }, fin.fetch)}
      customers={permissions.includes('customers:read') ? createCustomersClient(BASE, { kind: 'cookie' }, fin.fetch) : undefined}
      sales={createSalesClient(BASE, { kind: 'cookie' }, other.fetch)} projects={createProjectsClient(BASE, { kind: 'cookie' }, other.fetch)}
      context={ctx(permissions)} userLabel="Ada" section={o.section} initialTarget={o.target} initialAction={o.intent} {...handlers} />,
  );
  return { fin, other, handlers, user: userEvent.setup() };
}

async function pickCustomer(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText('Customer'), name.slice(0, 4));
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }));
}
const post = (api: ReturnType<typeof setup>['fin'], path: string) => api.calls.find((c) => c.method === 'POST' && c.path === path)!;

describe('quote and invoice forms: pickers and links (AC-2.2)', () => {
  it('lists only the chosen customer\'s projects and its open or won opportunities, and sends the picked ids', async () => {
    const { fin, user } = setup({ section: 'invoices', intent: 'new' });
    await heading('New invoice');
    // Nothing to pick until a customer is chosen, and the field says why.
    expect(screen.getByLabelText('Project')).toHaveProperty('disabled', true);
    expect(screen.getAllByText('Choose the customer first.')).toHaveLength(2);
    await pickCustomer(user, 'Acme Pty Ltd');
    const projects = await screen.findByRole('list', { name: 'Matching projects' });
    expect(within(projects).getAllByRole('button').map((b) => b.textContent)).toEqual(['Acme site worksActive']);
    const opps = await screen.findByRole('list', { name: 'Matching opportunities' });
    // Lost opportunities and other customers' opportunities are not offered; a customerless lead is not this customer's.
    expect(within(opps).getAllByRole('button').map((b) => b.textContent).sort()).toEqual(['Acme fit-outOpen', 'Acme service planWon']);
    await user.click(within(projects).getByRole('button', { name: /Acme site works/ }));
    await user.click(within(opps).getByRole('button', { name: /Acme fit-out/ }));
    expect(within(screen.getByRole('group', { name: 'Project' })).getByText('Acme site works')).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), 'Labour');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '100');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await heading('Draft invoice')).toBeTruthy();
    expect(post(fin, '/finance/invoices').body).toMatchObject({ customerId: acme.id, projectId: acmeProject.id, opportunityId: fitout.id });
  });

  it('a different customer clears a project and opportunity of the first one before saving, and says so', async () => {
    const { fin, user } = setup({ section: 'quotes', intent: 'new' });
    await heading('New quote');
    await pickCustomer(user, 'Acme Pty Ltd');
    await user.click(await within(await screen.findByRole('list', { name: 'Matching projects' })).findByRole('button', { name: /Acme site works/ }));
    await user.click(within(await screen.findByRole('list', { name: 'Matching opportunities' })).getByRole('button', { name: /Acme fit-out/ }));
    await user.click(screen.getByRole('button', { name: 'Change customer' }));
    await pickCustomer(user, 'Beta Builders');
    expect(screen.getByRole('status').textContent).toMatch(/project and opportunity you had chosen belonged to a different customer, so they were cleared/);
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();
    // Beta's own projects are now offered.
    expect(within(await screen.findByRole('list', { name: 'Matching projects' })).getByRole('button', { name: /Beta renovation/ })).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), 'Labour');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '5');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await heading('Draft quote');
    const body = post(fin, '/finance/quotes').body as Record<string, unknown>;
    expect(body).toMatchObject({ customerId: beta.id, projectId: null, opportunityId: null });
  });

  it('choosing the same customer again keeps the links', async () => {
    const { user } = setup({ section: 'quotes', intent: 'new' });
    await heading('New quote');
    await pickCustomer(user, 'Acme Pty Ltd');
    await user.click(await within(await screen.findByRole('list', { name: 'Matching projects' })).findByRole('button', { name: /Acme site works/ }));
    await user.click(screen.getByRole('button', { name: 'Change customer' }));
    await pickCustomer(user, 'Acme Pty Ltd');
    expect(within(screen.getByRole('group', { name: 'Project' })).getByText('Acme site works')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('without sales:read or projects:read there are no pickers and no link fields are sent', async () => {
    const { fin, user } = setup({ section: 'quotes', intent: 'new', permissions: ['finance:read', 'finance:write', 'customers:read'] });
    // The Zone was given both clients; the missing keys alone keep the fields away.
    await heading('New quote');
    await pickCustomer(user, 'Acme Pty Ltd');
    expect(screen.queryByRole('heading', { name: 'Links' })).toBeNull();
    expect(screen.queryByLabelText('Project')).toBeNull();
    expect(screen.queryByLabelText('Opportunity')).toBeNull();
    await user.type(screen.getByLabelText('Description'), 'Labour');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '5');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await heading('Draft quote');
    const body = post(fin, '/finance/quotes').body as Record<string, unknown>;
    expect('projectId' in body).toBe(false);
    expect('opportunityId' in body).toBe(false);
    expect(fin.calls.some((c) => c.path.includes('/projects') || c.path.includes('/sales'))).toBe(false);
  });

  it('editing a draft shows the linked names, lets the project go, and sends only what changed in the links', async () => {
    const draft = doc('INVOICE', { customerId: acme.id, billToSnapshot: null, projectId: acmeProject.id, opportunityId: fitout.id });
    const { fin, user } = setup({ section: 'invoices', documents: [draft] });
    await heading('Invoices');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd|Draft/ }));
    await heading('Draft invoice');
    await user.click(screen.getByRole('button', { name: 'Edit draft' }));
    await heading('Edit draft invoice');
    expect(await within(screen.getByRole('group', { name: 'Project' })).findByText('Acme site works')).toBeTruthy();
    expect(await within(screen.getByRole('group', { name: 'Opportunity' })).findByText('Acme fit-out')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove project' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await heading('Draft invoice');
    const patch = fin.calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
    expect(patch).toMatchObject({ projectId: null, opportunityId: fitout.id });
    expect(fin.businesses.alpha!.documents[0]!.projectId).toBeNull();
  });

  it('the server\'s customer rule has plain words (project, opportunity), never the raw error', async () => {
    // A draft whose saved project belongs to another customer: saving it unchanged is refused by the server.
    const draft = doc('QUOTE', { customerId: acme.id, billToSnapshot: null, projectId: betaProject.id });
    const { user } = setup({ section: 'quotes', documents: [draft] });
    await heading('Quotes');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd|Draft/ }));
    await heading('Draft quote');
    await user.click(screen.getByRole('button', { name: 'Edit draft' }));
    await heading('Edit draft quote');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toBe("This project belongs to a different customer. Choose one of this customer's projects, or clear the project.");
  });

  it('every one of the three link rules has its own message', () => {
    expect(linkErrorMessage('project_customer_mismatch')).toMatch(/different customer.*clear the project/);
    expect(linkErrorMessage('project_customer_locked')).toBe("This project's customer can't change because records for that customer are linked to it.");
    expect(linkErrorMessage('opportunity_customer_mismatch')).toMatch(/opportunity is for a different customer/);
    expect(linkErrorMessage('stale')).toBeUndefined();
    expect(linkErrorMessage(undefined)).toBeUndefined();
  });
});

describe('a quote started from an opportunity (AC-2.1)', () => {
  it('prefills customer, contact, currency and the opportunity link, and saves them', async () => {
    const { fin, user } = setup({ section: 'quotes', intent: 'new', target: `opportunity:${fitout.id}` });
    await heading('New quote');
    expect(await screen.findByText('Acme Pty Ltd')).toBeTruthy();
    expect((screen.getByLabelText('Currency') as HTMLSelectElement).value).toBe('USD');
    expect(within(screen.getByRole('group', { name: 'Opportunity' })).getByText('Acme fit-out')).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), 'Fit-out');
    await user.type(screen.getByLabelText('Unit price (USD)'), '900');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await heading('Draft quote');
    expect(post(fin, '/finance/quotes').body).toMatchObject({ customerId: acme.id, contactId: fitout.contactId, opportunityId: fitout.id, currencyCode: 'USD' });
    expect(fin.businesses.alpha!.documents[0]!.opportunityId).toBe(fitout.id);
  });

  it('an opportunity without a customer asks for one and keeps the link when a customer is chosen', async () => {
    const { fin, user } = setup({ section: 'quotes', intent: 'new', target: `opportunity:${anyOpp.id}` });
    await heading('New quote');
    expect(await screen.findByLabelText('Customer')).toBeTruthy();
    await pickCustomer(user, 'Beta Builders');
    expect(within(screen.getByRole('group', { name: 'Opportunity' })).getByText('Customerless lead')).toBeTruthy();
    await user.type(screen.getByLabelText('Description'), 'Work');
    await user.type(screen.getByLabelText('Unit price (AUD)'), '10');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await heading('Draft quote');
    expect(post(fin, '/finance/quotes').body).toMatchObject({ customerId: beta.id, opportunityId: anyOpp.id });
  });

  it('an opportunity that cannot be read is a problem with Try again, not a blank form', async () => {
    setup({ section: 'quotes', intent: 'new', target: `opportunity:${randomUUID()}`, opportunities: [] });
    expect(await screen.findByText(/This opportunity/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it('without sales:read the target is ignored: the plain form opens', async () => {
    setup({ section: 'quotes', intent: 'new', target: `opportunity:${fitout.id}`, permissions: ['finance:read', 'finance:write', 'customers:read'] });
    await heading('New quote');
    expect(screen.queryByText('Acme fit-out')).toBeNull();
  });
});

describe('expense form: customer and project (G-02)', () => {
  it('offers customers and projects, narrows projects to the customer, and sends both', async () => {
    const { fin, user } = setup({ section: 'expenses', intent: 'new' });
    await heading('New expense');
    // With no customer chosen every project is offered.
    const all = await screen.findByRole('list', { name: 'Matching projects' });
    expect(within(all).getAllByRole('button')).toHaveLength(2);
    await user.type(screen.getByLabelText('Description'), 'Pipe fittings');
    await user.type(screen.getByLabelText('Total paid'), '40');
    await user.type(screen.getByLabelText('Customer'), 'Acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    const narrowed = await screen.findByRole('list', { name: 'Matching projects' });
    await waitFor(() => expect(within(narrowed).getAllByRole('button').map((b) => b.textContent)).toEqual(['Acme site worksActive']));
    await user.click(within(narrowed).getByRole('button', { name: /Acme site works/ }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(fin.calls.some((c) => c.method === 'POST' && c.path === '/finance/expenses')).toBe(true));
    expect(post(fin, '/finance/expenses').body).toMatchObject({ customerId: acme.id, projectId: acmeProject.id });
  });

  it('a different customer clears a project of another customer', async () => {
    const { user } = setup({ section: 'expenses', intent: 'new' });
    await heading('New expense');
    await user.click(await within(await screen.findByRole('list', { name: 'Matching projects' })).findByRole('button', { name: /Beta renovation/ }));
    await user.type(screen.getByLabelText('Customer'), 'Acme');
    await user.click(await screen.findByRole('button', { name: /Acme Pty Ltd/ }));
    expect(screen.getByRole('status').textContent).toMatch(/project you had chosen belongs to a different customer/);
    expect(screen.queryByRole('group', { name: 'Project' })).toBeNull();
  });

  it('shows neither field without customers:read and projects:read', async () => {
    setup({ section: 'expenses', intent: 'new', permissions: ['finance:read', 'finance:expenses'] });
    await heading('New expense');
    expect(screen.queryByRole('heading', { name: 'Customer and project' })).toBeNull();
  });
});

describe('link chips on a finance document (G-04)', () => {
  const linked = (over = {}) => issued('INVOICE', acme, 'INV-0001', { projectId: acmeProject.id, opportunityId: fitout.id, ...over });

  it('shows the opportunity and project by name and state, and opens them in their own Zone', async () => {
    const invoice = linked();
    const { handlers, user } = setup({ section: 'invoices', target: `invoice:${invoice.id}`, documents: [invoice] });
    await heading('INV-0001');
    const opp = await screen.findByRole('button', { name: 'Acme fit-out' });
    expect(opp.parentElement!.textContent).toContain('Open');
    await user.click(opp);
    expect(handlers.onOpenOpportunity).toHaveBeenCalledWith(fitout.id);
    await user.click(await screen.findByRole('button', { name: 'Acme site works' }));
    expect(handlers.onOpenProject).toHaveBeenCalledWith(acmeProject.id);
  });

  it('shows no chip at all for a viewer without that Zone\'s key', async () => {
    const invoice = linked();
    const { other } = setup({ section: 'invoices', target: `invoice:${invoice.id}`, documents: [invoice], permissions: ['finance:read', 'customers:read'] });
    await heading('INV-0001');
    expect(screen.queryByText('Opportunity')).toBeNull();
    expect(screen.queryByText('Project')).toBeNull();
    expect(screen.queryByText('Acme fit-out')).toBeNull();
    expect(other.calls.filter((c) => /\/(sales|projects)\//.test(c.path))).toHaveLength(0);
  });

  it('a record that cannot be read is said plainly, with no name', async () => {
    const invoice = linked({ opportunityId: randomUUID() });
    setup({ section: 'invoices', target: `invoice:${invoice.id}`, documents: [invoice] });
    await heading('INV-0001');
    expect(await screen.findByText('This opportunity can’t be shown.')).toBeTruthy();
  });
});

describe('opportunity: Quotes and invoices panel (AC-2.3)', () => {
  function salesSetup(permissions: string[]) {
    const quote = issued('QUOTE', acme, 'QUO-0001', { opportunityId: fitout.id, amount: '900.00', currencyCode: 'USD' });
    const invoice = issued('INVOICE', acme, 'INV-0007', { opportunityId: fitout.id, amount: '450.00' });
    const draft = doc('INVOICE', { customerId: acme.id, opportunityId: fitout.id, amount: '10.00' });
    const unrelated = issued('QUOTE', acme, 'QUO-0099', { opportunityId: wonOpp.id });
    const fin = createFakeFinance({ alpha: financeData({ customers: [acme], documents: [quote, invoice, draft, unrelated] }) });
    const biz = { ...emptyBusiness(), customers: [acme] };
    const salesApi = withSales(createFakeApi({ alpha: biz }), { alpha: { ...emptySales(), pipelines: [pipeline], opportunities: [fitout] } });
    const onOpen = vi.fn();
    const onCreateQuote = vi.fn();
    render(
      <SalesZone sales={createSalesClient(BASE, { kind: 'cookie' }, salesApi.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, salesApi.fetch)}
        finance={{ client: createFinanceClient(BASE, { kind: 'cookie' }, fin.fetch), onOpen, onCreateQuote }}
        context={ctx(permissions)} userLabel="Ada" initialOpportunityId={fitout.id} onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    return { fin, onOpen, onCreateQuote, user: userEvent.setup() };
  }

  it('lists this opportunity\'s quotes and invoices (drafts without a number, each in its own currency) and opens them', async () => {
    const { fin, onOpen, onCreateQuote, user } = salesSetup(['sales:read', 'sales:write', 'finance:read', 'finance:write', 'customers:read']);
    const panel = await screen.findByRole('region', { name: 'Quotes and invoices' });
    const rows = await within(panel).findAllByRole('button');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.textContent).sort()).toEqual([
      expect.stringContaining('Invoice (draft)'), expect.stringContaining('Invoice INV-0007'), expect.stringContaining('Quote QUO-0001'),
    ]);
    expect(within(panel).getByText(/USD.*900\.00|900\.00.*USD|US\$900\.00/)).toBeTruthy();
    expect(within(panel).queryByText(/QUO-0099/)).toBeNull();
    expect(fin.calls.filter((c) => c.method === 'GET' && c.query.opportunityId === fitout.id).map((c) => c.path).sort()).toEqual(['/finance/invoices', '/finance/quotes']);
    await user.click(within(panel).getByRole('button', { name: /Quote QUO-0001/ }));
    expect(onOpen).toHaveBeenCalledWith('quotes', expect.any(String));
    await user.click(screen.getByRole('button', { name: 'Create quote' }));
    expect(onCreateQuote).toHaveBeenCalledWith(fitout.id);
  });

  it('is absent for a person without finance:read: no panel, no heading, no request to Finance, no quote number in the DOM', async () => {
    const { fin } = salesSetup(['sales:read', 'sales:write', 'customers:read']);
    await heading('Acme fit-out');
    expect(screen.queryByRole('region', { name: 'Quotes and invoices' })).toBeNull();
    expect(screen.queryByText(/Quotes and invoices/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/QUO-|INV-/);
    expect(fin.calls).toHaveLength(0);
  });

  it('offers no "Create quote" to someone who can read Finance but not write it', async () => {
    salesSetup(['sales:read', 'finance:read', 'customers:read']);
    expect(await screen.findByRole('region', { name: 'Quotes and invoices' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create quote' })).toBeNull();
  });

  it('an empty panel says so for a finance reader', async () => {
    const fin = createFakeFinance({ alpha: financeData({ customers: [acme] }) });
    const salesApi = withSales(createFakeApi({ alpha: { ...emptyBusiness(), customers: [acme] } }), { alpha: { ...emptySales(), pipelines: [pipeline], opportunities: [fitout] } });
    render(
      <SalesZone sales={createSalesClient(BASE, { kind: 'cookie' }, salesApi.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, salesApi.fetch)}
        finance={{ client: createFinanceClient(BASE, { kind: 'cookie' }, fin.fetch), onOpen: vi.fn() }}
        context={ctx(['sales:read', 'finance:read'])} userLabel="Ada" initialOpportunityId={fitout.id} onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />,
    );
    expect(await screen.findByText('No quotes or invoices are linked to this opportunity yet.')).toBeTruthy();
  });
});

describe('project form: the customer-lock rules (AC-2.4)', () => {
  it('project_customer_locked and project_customer_mismatch show their own plain messages', async () => {
    const proj = project({ name: 'Acme site works', customerId: acme.id, customer: { id: acme.id, displayName: 'Acme Pty Ltd' } } as never);
    const biz = { ...emptyBusiness(), customers: [acme, beta], members: [{ id: uuid(), userId: uuid(), name: 'Ada', role: 'OWNER' as const, status: 'ACTIVE' as const, createdAt: NOW }] };
    const api = withProjects(createFakeApi({ alpha: biz }), { alpha: { ...emptyProjects(), projects: [proj] } });
    const user = userEvent.setup();
    render(<ProjectsZone client={createProjectsClient(BASE, { kind: 'cookie' }, api.fetch)} customers={createCustomersClient(BASE, { kind: 'cookie' }, api.fetch)}
      context={ctx(['projects:read', 'projects:update', 'projects:create', 'customers:read', 'members:read', 'business:read'])} userLabel="Ada"
      initialProjectId={proj.id} onHome={vi.fn()} onSwitch={vi.fn()} onSignOut={vi.fn()} onSessionEnded={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await heading('Edit Acme site works');
    api.projectsNext((path, method) => (method === 'PATCH' ? new Response(JSON.stringify({ error: 'project_customer_locked' }), { status: 409, headers: { 'content-type': 'application/json' } }) : undefined));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Acme site works 2');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect((await screen.findAllByText("This project's customer can't change because records for that customer are linked to it.")).length).toBeGreaterThan(0);
    api.projectsNext((path, method) => (method === 'PATCH' ? new Response(JSON.stringify({ error: 'project_customer_mismatch', message: 'raw server text' }), { status: 400, headers: { 'content-type': 'application/json' } }) : undefined));
    await user.click(screen.getByRole('button', { name: /Save changes/ }));
    expect((await screen.findAllByText(/This project belongs to a different customer/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('raw server text')).toBeNull();
  });
});
