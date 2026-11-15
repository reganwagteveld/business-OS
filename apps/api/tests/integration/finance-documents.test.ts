/**
 * Finance F5 (docs/finance-documents-f5.md): generated quote and invoice documents through the real
 * route handlers, against PostgreSQL with the migrations applied as in production. Two businesses,
 * every role. Generated PDFs are read back with pdf.js, so the assertions are about the document's
 * actual text, pages and bytes, not only about HTTP statuses.
 */
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Permission, Role } from '@/modules/access';
import { readPdf } from '../support/pdf';
import { png } from '../support/png';

const custom: Partial<Record<Role, Permission[]>> = {};
vi.mock('@/modules/access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/access')>();
  return { ...real, permissionsFor: (role: Role) => custom[role] ?? real.permissionsFor(role) };
});
// Lets one test make rendering fail, to prove a failed generation stores nothing and can be retried.
const renderFailure = { remaining: 0 };
vi.mock('@/modules/finance/server/pdf/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/finance/server/pdf/render')>();
  return {
    ...real,
    renderDocument: async (...args: Parameters<typeof real.renderDocument>) => {
      if (renderFailure.remaining > 0) {
        renderFailure.remaining--;
        throw new Error('renderer crashed');
      }
      return real.renderDocument(...args);
    },
  };
});

import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as customerRoute from '@/app/api/v1/b/[slug]/customers/[customerId]/route';
import * as contactsRoute from '@/app/api/v1/b/[slug]/contacts/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import * as quoteIssue from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/issue/route';
import * as quoteAccept from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/accept/route';
import * as quoteConvert from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/convert/route';
import * as invoicesRoute from '@/app/api/v1/b/[slug]/finance/invoices/route';
import * as invoiceRoute from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/route';
import * as invoiceIssue from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/issue/route';
import * as invoiceVoid from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/void/route';
import * as invoiceDiscard from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/discard/route';
import * as paymentsRoute from '@/app/api/v1/b/[slug]/finance/payments/route';
import * as settingsRoute from '@/app/api/v1/b/[slug]/finance/settings/route';
import * as seriesRoute from '@/app/api/v1/b/[slug]/finance/number-series/[kind]/route';
import * as seriesListRoute from '@/app/api/v1/b/[slug]/finance/number-series/route';
import * as taxRatesRoute from '@/app/api/v1/b/[slug]/finance/tax-rates/route';
import * as brandingRoute from '@/app/api/v1/b/[slug]/finance/document-branding/route';
import * as logoRoute from '@/app/api/v1/b/[slug]/finance/document-branding/logo/route';
import * as invVersions from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/pdf-versions/route';
import * as invVersion from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/pdf-versions/[versionId]/route';
import * as invPreview from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/pdf-versions/[versionId]/preview/route';
import * as invDownload from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/pdf-versions/[versionId]/download/route';
import * as invDraft from '@/app/api/v1/b/[slug]/finance/invoices/[documentId]/draft-pdf/route';
import * as quoteVersions from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/pdf-versions/route';
import * as quotePreview from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/pdf-versions/[versionId]/preview/route';
import * as quoteDownload from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/pdf-versions/[versionId]/download/route';
import * as quoteDraft from '@/app/api/v1/b/[slug]/finance/quotes/[documentId]/draft-pdf/route';
import { devOutbox } from '@/core/email';
import { renderDocument } from '@/modules/finance/server/pdf/render';
import type { DocumentSnapshot } from '@/modules/finance/server/pdf/snapshot';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });

beforeAll(async () => {
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});
afterEach(() => {
  for (const key of Object.keys(custom)) delete custom[key as Role];
  renderFailure.remaining = 0;
});

let ip = 1;
const block = process.env.FINANCE_DOCS_TEST_IP_BLOCK ?? '86';
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${block}.${Math.floor(ip / 250)}.${ip++ % 250}`, ...(opts.headers ?? {}) });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(req('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

async function invite(slug: string, owner: User, user: User, role: string) {
  await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
  const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
  const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
  expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
}

async function team(label: string, currency = 'AUD', locale = 'en-AU') {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale, currency },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
    const user = await newUser(`${label}-${role.toLowerCase()}`);
    await invite(slug, owner, user, role);
    people[role] = user;
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json(), headers: res.headers });
const file = async (res: Response) => {
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, bytes, headers: res.headers, json: () => JSON.parse(bytes.toString('utf8')) };
};
type Seg = 'quotes' | 'invoices';
const R = {
  quotes: { versions: quoteVersions, preview: quotePreview, download: quoteDownload, draft: quoteDraft, issue: quoteIssue },
  invoices: { versions: invVersions, preview: invPreview, download: invDownload, draft: invDraft, issue: invoiceIssue },
} as const;

const api = (who: User, slug: string) => {
  const F = `/api/v1/b/${slug}/finance`;
  const d = (documentId: string, extra: Record<string, string> = {}) => ctx({ slug, documentId, ...extra });
  const post = (route: { POST: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response> }, path: string, c: ReturnType<typeof ctx>, body?: unknown) =>
    route.POST(req('POST', `${F}${path}`, { cookie: who.cookie, body }), c).then(json);
  return {
    createQuote: (body: unknown) => post(quotesRoute, '/quotes', ctx({ slug }), body),
    createInvoice: (body: unknown) => post(invoicesRoute, '/invoices', ctx({ slug }), body),
    patchInvoice: (id: string, body: unknown) => invoiceRoute.PATCH(req('PATCH', `${F}/invoices/${id}`, { cookie: who.cookie, body }), d(id)).then(json),
    issue: (seg: Seg, id: string, body: unknown) => post(R[seg].issue, `/${seg}/${id}/issue`, d(id), body),
    accept: (id: string, body: unknown) => post(quoteAccept, `/quotes/${id}/accept`, d(id), body),
    convert: (id: string, body: unknown = {}) => post(quoteConvert, `/quotes/${id}/convert`, d(id), body),
    void: (id: string, body: unknown) => post(invoiceVoid, `/invoices/${id}/void`, d(id), body),
    discard: (id: string, body: unknown) => post(invoiceDiscard, `/invoices/${id}/discard`, d(id), body),
    pay: (body: unknown) => paymentsRoute.POST(req('POST', `${F}/payments`, { cookie: who.cookie, body, headers: { 'idempotency-key': randomUUID() } }), ctx({ slug })).then(json),
    patchSettings: (body: unknown) => settingsRoute.PATCH(req('PATCH', `${F}/settings`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    patchSeries: (kind: string, body: unknown) => seriesRoute.PATCH(req('PATCH', `${F}/number-series/${kind}`, { cookie: who.cookie, body }), ctx({ slug, kind })).then(json),
    createTaxRate: (body: unknown) => post(taxRatesRoute, '/tax-rates', ctx({ slug }), body),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    updateCustomer: (customerId: string, body: unknown) => customerRoute.PATCH(req('PATCH', `/api/v1/b/${slug}/customers/${customerId}`, { cookie: who.cookie, body }), ctx({ slug, customerId })).then(json),
    createContact: (body: unknown) => contactsRoute.POST(req('POST', `/api/v1/b/${slug}/contacts`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    branding: () => brandingRoute.GET(req('GET', `${F}/document-branding`, { cookie: who.cookie }), ctx({ slug })).then(json),
    patchBranding: (body: unknown) => brandingRoute.PATCH(req('PATCH', `${F}/document-branding`, { cookie: who.cookie, body }), ctx({ slug })).then(json),
    uploadLogo: (body: unknown) => post(logoRoute, '/document-branding/logo', ctx({ slug }), body),
    logo: () => logoRoute.GET(req('GET', `${F}/document-branding/logo`, { cookie: who.cookie }), ctx({ slug })).then(file),
    versions: (seg: Seg, id: string) => R[seg].versions.GET(req('GET', `${F}/${seg}/${id}/pdf-versions`, { cookie: who.cookie }), d(id)).then(json),
    generate: (seg: Seg, id: string, body: unknown = { mode: 'original' }) => post(R[seg].versions, `/${seg}/${id}/pdf-versions`, d(id), body),
    version: (id: string, versionId: string) => invVersion.GET(req('GET', `${F}/invoices/${id}/pdf-versions/${versionId}`, { cookie: who.cookie }), d(id, { versionId })).then(json),
    preview: (seg: Seg, id: string, versionId: string) =>
      R[seg].preview.GET(req('GET', `${F}/${seg}/${id}/pdf-versions/${versionId}/preview`, { cookie: who.cookie }), d(id, { versionId })).then(file),
    download: (seg: Seg, id: string, versionId: string, origin?: string) =>
      R[seg].download.GET(req('GET', `${F}/${seg}/${id}/pdf-versions/${versionId}/download`, { cookie: who.cookie, origin }), d(id, { versionId })).then(file),
    draftPdf: (seg: Seg, id: string) => R[seg].draft.GET(req('GET', `${F}/${seg}/${id}/draft-pdf`, { cookie: who.cookie }), d(id)).then(file),
  };
};
const audits = async (targetId: string) =>
  (await admin.query('SELECT action, actor_user_id, business_id, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows;
/** pdf.js reports kerned runs with stray spaces ("7 .625%"), so content checks compare text without whitespace. */
const squash = (text: string) => text.replace(/\s+/g, '');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let A: Awaited<ReturnType<typeof team>>;
let B: Awaited<ReturnType<typeof team>>;
let custA: string;
let contactA: string;
let custB: string;
let gst: string;
let reduced: string;
const line = (over: Record<string, unknown> = {}) => ({ description: 'Consulting', quantity: '2', unitPrice: '150', ...over });

beforeAll(async () => {
  A = await team('fda');
  B = await team('fdb', 'EUR', 'de-DE');
  const owner = api(A.people.OWNER!, A.slug);
  custA = (await owner.createCustomer({
    displayName: 'Acme', legalName: 'Acme Pty Ltd', addressLine1: '1 Old Street', city: 'Perth', region: 'WA', postalCode: '6000', countryCode: 'AU',
    taxNumber: '51 824 753 556', taxNumberType: 'au_abn', email: 'ap@acme.example',
  })).body.customer.id;
  contactA = (await owner.createContact({ customerId: custA, displayName: 'Jordan Lee', email: 'jordan@acme.example' })).body.contact.id;
  custB = (await api(B.people.OWNER!, B.slug).createCustomer({ displayName: 'B Kunde GmbH' })).body.customer.id;
  gst = (await owner.createTaxRate({ name: 'GST', ratePercent: '10' })).body.taxRate.id;
  reduced = (await owner.createTaxRate({ name: 'Reduced', ratePercent: '7.625' })).body.taxRate.id;
  expect((await owner.patchSettings({
    version: 0, sellerLegalName: 'Harbour Studio Pty Ltd', sellerAddress: '12 Wharf Street\nFremantle WA 6160', sellerEmail: 'accounts@harbour.example',
    sellerIdentifiers: [{ label: 'ABN', value: '12 345 678 901' }], paymentInstructions: 'BSB 000-000 Account 12345678', defaultPaymentTermsDays: 30,
    defaultQuoteValidityDays: 30,
  })).status).toBe(200);
}, 180_000);

/** An issued invoice in business A with the given lines. */
async function issuedInvoice(lines: unknown[], over: Record<string, unknown> = {}) {
  const own = api(A.people.OWNER!, A.slug);
  const draft = await own.createInvoice({ customerId: custA, contactId: contactA, lines, ...over });
  expect(draft.status).toBe(201);
  const issued = await own.issue('invoices', draft.body.document.id, { version: 1, issueDate: '2026-11-15', dueDate: '2026-12-15' });
  expect(issued.status).toBe(200);
  return issued.body.document as { id: string; number: string; total: string; subtotal: string; taxTotal: string; version: number; contentSha256: string };
}

describe('invoice and quote content', () => {
  it('renders an issued invoice from its sealed record: numbers, dates, parties, lines, tax breakdown and exact totals', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([
      line({ taxRateId: gst }),
      line({ description: 'Licence', quantity: '3', unitPrice: '33.3333', taxRateId: reduced }),
      line({ description: 'Travel', quantity: '1', unitPrice: '99.99', discountAmount: '9.99' }),
    ]);
    expect(inv).toMatchObject({ subtotal: '490.00', taxTotal: '37.63', total: '527.63' }); // 3 × 33.3333 = 99.9999 → 100.00; 7.625% → 7.625 → 7.63 (half away from zero)
    const created = await own.generate('invoices', inv.id);
    expect(created.status).toBe(201);
    const v = created.body.version;
    expect(v).toMatchObject({
      documentId: inv.id, documentKind: 'INVOICE', versionNumber: 1, reason: 'ORIGINAL', previousVersionId: null, documentNumber: inv.number,
      documentStatus: 'ISSUED', documentContentSha256: inv.contentSha256, templateId: 'standard', templateVersion: 1, contentType: 'application/pdf',
      fileName: `${inv.number}.pdf`, generatedById: A.people.OWNER!.id, unsupportedCharacters: false,
      reference: { type: 'finance_document_pdf', id: v.id, sha256: v.fileSha256 },
    });
    expect(v.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // random (v4), not guessable

    const dl = await own.download('invoices', inv.id, v.id);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(dl.headers.get('content-disposition')).toBe(`attachment; filename="${inv.number}.pdf"; filename*=UTF-8''${inv.number}.pdf`);
    expect(dl.headers.get('cache-control')).toBe('private, no-store');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-length')).toBe(String(dl.bytes.length));
    expect(dl.headers.get('x-document-sha256')).toBe(v.fileSha256);
    expect(sha(dl.bytes)).toBe(v.fileSha256);
    expect(dl.bytes.length).toBe(v.byteSize);
    expect(dl.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const pdf = await readPdf(dl.bytes);
    expect(pdf.pageSizes).toEqual([[595.28, 841.89]]); // A4
    expect(pdf.info).toMatchObject({ Title: `Invoice ${inv.number}`, Author: 'Harbour Studio Pty Ltd', Producer: 'Business OS' });
    for (const expected of [
      'Invoice', inv.number, 'Harbour Studio Pty Ltd', '12 Wharf Street', 'Fremantle WA 6160', 'ABN: 12 345 678 901', 'accounts@harbour.example',
      'BILL TO', 'Acme Pty Ltd', 'Attn: Jordan Lee', '1 Old Street', 'Perth WA 6000', 'Australia', 'ABN: 51 824 753 556', 'jordan@acme.example',
      'ISSUE DATE', '15 Nov 2026', 'DUE DATE', '15 Dec 2026', 'AUD',
      'Consulting', 'GST 10%', '$300.00', 'Licence', '$33.3333', 'Reduced 7.625%', 'Travel', '$9.99', '$90.00', 'No tax',
      'Subtotal', '$490.00', 'GST 10% on $300.00', '$30.00', 'Reduced 7.625% on $100.00', '$7.63', 'Total AUD', '$527.63',
      'PAYMENT INSTRUCTIONS', 'BSB 000-000 Account 12345678', `${inv.number} · Page 1 of 1`,
    ]) expect(squash(pdf.text), expected).toContain(squash(expected));
    // The document is the issued record, not its settlement: no paid/unpaid/overdue wording, nothing "sent".
    expect(pdf.text).not.toMatch(/paid|overdue|sent|DRAFT/i);
  });

  it('renders an issued quote with its validity date, quote terms and the quote title', async () => {
    const own = api(A.people.OWNER!, A.slug);
    await own.patchBranding({ version: (await own.branding()).body.branding.version, quoteTitle: 'Proposal', quoteTerms: 'Valid for 30 days. Prices in AUD.' });
    const q = await own.createQuote({ customerId: custA, lines: [line({ taxRateId: gst })] });
    const issued = await own.issue('quotes', q.body.document.id, { version: 1, issueDate: '2026-11-15', validUntil: '2026-12-31' });
    const v = (await own.generate('quotes', issued.body.document.id)).body.version;
    const pdf = await readPdf((await own.download('quotes', issued.body.document.id, v.id)).bytes);
    for (const expected of ['Proposal', issued.body.document.number, 'PREPARED FOR', 'VALID UNTIL', '31 Dec 2026', 'TERMS OF THIS QUOTE', 'Valid for 30 days. Prices in AUD.', 'Total AUD', '$330.00']) {
      expect(squash(pdf.text), expected).toContain(squash(expected));
    }
    expect(pdf.text).not.toContain('PAYMENT INSTRUCTIONS'); // quotes are not payable
    expect(pdf.text).not.toContain('DUE DATE');
  });

  it('formats amounts in the business locale and the document currency, exactly (EUR in de-DE, many rates)', async () => {
    const own = api(B.people.OWNER!, B.slug);
    const vat = (await own.createTaxRate({ name: 'MwSt', ratePercent: '19' })).body.taxRate.id;
    const red = (await own.createTaxRate({ name: 'MwSt ermäßigt', ratePercent: '7' })).body.taxRate.id;
    const draft = await own.createInvoice({ customerId: custB, lines: [
      { description: 'Beratung', quantity: '1.5', unitPrice: '1234.565', taxRateId: vat },
      { description: 'Bücher', quantity: '7', unitPrice: '19.99', taxRateId: red },
      { description: 'Porto', quantity: '1', unitPrice: '4.9' },
    ] });
    const inv = (await own.issue('invoices', draft.body.document.id, { version: 1, issueDate: '2026-11-15', dueDate: '2026-11-29' })).body.document;
    expect(inv).toMatchObject({ subtotal: '1996.68', taxTotal: '361.65', total: '2358.33' });
    const v = (await own.generate('invoices', inv.id)).body.version;
    const pdf = await readPdf((await own.download('invoices', inv.id, v.id)).bytes);
    for (const expected of ['1.851,85 €', 'MwSt 19% on 1.851,85 €', '351,85 €', 'MwSt ermäßigt 7% on 139,93 €', '9,80 €', '1.996,68 €', 'Total EUR', '2.358,33 €', '1,5', '1.234,565 €']) {
      expect(squash(pdf.text), expected).toContain(squash(expected));
    }
  });
});

describe('pagination, long text and Unicode', () => {
  it('paginates 200 lines over several A4 pages with the table header and page numbers on every page and the totals once', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const lines = Array.from({ length: 200 }, (_, i) => line({ description: `Item ${i + 1}`, quantity: '1', unitPrice: `${i + 1}.01`, taxRateId: i % 2 ? gst : null }));
    const inv = await issuedInvoice(lines);
    const started = Date.now();
    const v = (await own.generate('invoices', inv.id)).body.version;
    const elapsed = Date.now() - started;
    expect(v.pageCount).toBeGreaterThan(3);
    const pdf = await readPdf((await own.download('invoices', inv.id, v.id)).bytes);
    expect(pdf.pages).toHaveLength(v.pageCount);
    pdf.pages.forEach((page, i) => {
      expect(page).toContain(`Page ${i + 1} of ${v.pageCount}`);
      expect(page).toContain('DESCRIPTION');
      expect(pdf.pageSizes[i]).toEqual([595.28, 841.89]);
    });
    for (const n of [1, 57, 123, 200]) expect(pdf.text).toContain(`Item ${n}\n`.trim());
    expect(pdf.text.match(/Total AUD/g)).toHaveLength(1);
    expect(pdf.pages.at(-1)).toContain(`$${Number(inv.total).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`);
    expect(elapsed).toBeLessThan(5_000);
  });

  it('wraps long descriptions, keeps Unicode text, prints user text literally and embeds no active content', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const long = `${'Long description with many words to force wrapping across lines. '.repeat(14)}END`.slice(0, 1000);
    const hostile = 'Café Ünïcödé — ÆØÅ ß €; Ελληνικά; Кириллица (paren) \\ backslash ) /JavaScript <script>alert(1)</script> javascript:alert(1)';
    const inv = await issuedInvoice([line({ description: long }), line({ description: hostile })], { notes: 'Merci beaucoup! Žluťoučký kůň.\nSecond line' });
    const created = await own.generate('invoices', inv.id);
    expect(created.body.version.unsupportedCharacters).toBe(false);
    const dl = await own.download('invoices', inv.id, created.body.version.id);
    const pdf = await readPdf(dl.bytes);
    const flat = pdf.text.replace(/\s+/g, ' ');
    expect(flat).toContain('Long description with many words');
    expect(flat).toContain('END');
    for (const s of ['Café Ünïcödé — ÆØÅ ß €;', 'Ελληνικά; Кириллица', '(paren) \\ backslash )', '/JavaScript <script>alert(1)</script>', 'Merci beaucoup! Žluťoučký kůň.']) {
      expect(flat).toContain(s);
    }
    // User text is drawn as text only: no JavaScript, launch, URI or form actions, no external references.
    const raw = dl.bytes.toString('latin1');
    for (const key of ['/JavaScript', '/JS ', '/Launch', '/URI', '/SubmitForm', '/OpenAction', '/AA ', '/EmbeddedFile', '/Annots', 'https://']) expect(raw).not.toContain(key);
    // The only http:// strings are the XMP metadata's namespace names (identifiers, never fetched).
    expect([...raw.matchAll(/http:\/\/[^"\s]+/g)].map((m) => m[0]).every((u) => /^http:\/\/(www\.w3\.org|ns\.adobe\.com|purl\.org)\//.test(u))).toBe(true);
  });

  it('reports characters the embedded font cannot show (for example CJK) instead of hiding them', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line({ description: '翻訳サービス' })]);
    const created = await own.generate('invoices', inv.id);
    expect(created.status).toBe(201);
    expect(created.body.version.unsupportedCharacters).toBe(true);
  });
});

describe('branding and assets', () => {
  it('validates logos by content, size and dimensions, and refuses SVG, mismatched and broken images', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const version = (await own.branding()).body.branding.version;
    const up = (contentType: string, bytes: Buffer, v = version) => own.uploadLogo({ version: v, contentType, dataBase64: bytes.toString('base64') });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    expect((await up('image/svg+xml', svg)).status).toBe(400); // not even an accepted type in the contract
    expect((await up('image/png', svg)).body.error).toBe('unsupported_image');
    expect((await up('image/jpeg', png(10, 10))).body.error).toBe('unsupported_image'); // declared type must match the bytes
    const broken = Buffer.concat([png(10, 10).subarray(0, 33), Buffer.from('not a real image stream at all, sorry')]);
    expect((await up('image/png', broken)).body.error).toBe('invalid_image');
    expect((await up('image/png', png(2001, 5))).body.error).toBe('image_dimensions');
    const huge = Buffer.concat([png(10, 10), Buffer.alloc(520 * 1024, 1)]);
    expect([(await up('image/png', huge)).body.error]).toEqual([expect.stringMatching(/image_too_large|invalid_input/)]);
    expect((await own.logo()).status).toBe(404); // nothing was stored by any refused upload
    const n = await admin.query('SELECT count(*)::int AS n FROM finance_branding_assets WHERE business_id = $1', [A.businessId]);
    expect(n.rows[0].n).toBe(0);
    // MANAGER may not change branding; MEMBER may not even read it.
    expect((await api(A.people.MANAGER!, A.slug).uploadLogo({ version, contentType: 'image/png', dataBase64: png(10, 10).toString('base64') })).status).toBe(403);
    expect((await api(A.people.MEMBER!, A.slug).branding()).status).toBe(403);
  });

  it('stores a valid logo immutably, embeds it in new versions, and removing it affects only later versions', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const before = (await own.branding()).body.branding;
    const image = png(300, 100);
    const uploaded = await own.uploadLogo({ version: before.version, contentType: 'image/png', dataBase64: image.toString('base64') });
    expect(uploaded.status).toBe(201);
    const logo = uploaded.body.branding.logo;
    expect(logo).toMatchObject({ contentType: 'image/png', width: 300, height: 100, byteSize: image.length, sha256: sha(image) });
    const served = await own.logo();
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(sha(served.bytes)).toBe(logo.sha256);

    const inv = await issuedInvoice([line({ taxRateId: gst })]);
    const v1 = (await own.generate('invoices', inv.id)).body.version;
    expect(v1.logoAssetId).toBe(logo.id);
    const v1Bytes = (await own.download('invoices', inv.id, v1.id)).bytes;
    expect(v1Bytes.toString('latin1')).toContain('/Subtype /Image');

    const removed = await own.patchBranding({ version: uploaded.body.branding.version, logoAssetId: null });
    expect(removed.body.branding.logo).toBeNull();
    const v2 = (await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'BRANDING_UPDATED', basedOnVersion: 1 })).body.version;
    expect(v2.logoAssetId).toBeNull();
    expect((await own.download('invoices', inv.id, v2.id)).bytes.toString('latin1')).not.toContain('/Subtype /Image');
    expect(sha((await own.download('invoices', inv.id, v1.id)).bytes)).toBe(v1.fileSha256); // v1 still has its logo
    // The asset is immutable for every role, including the table owner.
    await expect(admin.query('UPDATE finance_branding_assets SET width = 1 WHERE id = $1', [logo.id])).rejects.toMatchObject({ code: 'FN021' });
    await expect(admin.query('DELETE FROM finance_branding_assets WHERE id = $1', [logo.id])).rejects.toMatchObject({ code: expect.stringMatching(/FN021|23503/) });
    const actions = (await audits(A.businessId)).filter((a) => a.action === 'finance.branding.changed').map((a) => a.metadata.fields);
    expect(actions).toEqual(expect.arrayContaining([['logoAssetId']]));
  });

  it('validates branding fields and keeps optimistic concurrency', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const b = (await own.branding()).body.branding;
    expect((await own.patchBranding({ version: b.version, accentColor: 'red' })).status).toBe(400);
    expect((await own.patchBranding({ version: b.version, footerText: 'x'.repeat(501) })).status).toBe(400);
    expect((await own.patchBranding({ version: b.version, logoAssetId: randomUUID() })).body.error).toBe('invalid_logo');
    const ok = await own.patchBranding({ version: b.version, accentColor: '#0a7d4f', footerText: 'Registered in WA' });
    expect(ok.body.branding).toMatchObject({ accentColor: '#0A7D4F', footerText: 'Registered in WA', version: b.version + 1 });
    expect((await own.patchBranding({ version: b.version, footerText: 'Lost update' })).body.error).toBe('stale');
  });
});

describe('drafts, snapshots and versions', () => {
  it('previews drafts on demand (watermarked, never stored) and renders empty or edge-case drafts', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const empty = await own.createInvoice({ customerId: custA });
    const preview = await own.draftPdf('invoices', empty.body.document.id);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toBe(`inline; filename="draft-invoice-preview.pdf"; filename*=UTF-8''draft-invoice-preview.pdf`);
    const pdf = await readPdf(preview.bytes);
    for (const s of ['DRAFT', 'Draft preview: not issued, not a valid document', 'Draft, not issued', 'No lines yet.', 'Total AUD', '$0.00']) expect(pdf.text).toContain(s);
    // Edge cases a draft may hold: a line discounted to zero and a zero-rated line.
    await own.patchInvoice(empty.body.document.id, { version: 1, lines: [line({ quantity: '1', unitPrice: '10', discountAmount: '10' }), line({ taxRateId: gst, quantity: '0.000001', unitPrice: '0.01' })] });
    const edge = await readPdf((await own.draftPdf('invoices', empty.body.document.id)).bytes);
    expect(edge.text).toContain('$0.00');
    expect(edge.text.replace(/\s+/g, '')).toContain('0.000001');
    expect((await own.versions('invoices', empty.body.document.id)).body).toEqual({ eligible: false, versions: [] });
    expect((await own.generate('invoices', empty.body.document.id)).body.error).toBe('not_eligible');
    const stored = await admin.query('SELECT count(*)::int AS n FROM finance_document_pdfs WHERE document_id = $1', [empty.body.document.id]);
    expect(stored.rows[0].n).toBe(0);
    // A discarded draft is never eligible; an issued document has no draft preview.
    const discarded = await own.discard(empty.body.document.id, { version: 2 });
    expect(discarded.status).toBe(200);
    expect((await own.generate('invoices', empty.body.document.id)).body.error).toBe('not_eligible');
    const inv = await issuedInvoice([line()]);
    expect((await own.draftPdf('invoices', inv.id)).json().error).toBe('not_draft');
  });

  it('keeps historical versions unchanged when branding, the customer, seller settings or payments change; a new version says why', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line({ taxRateId: gst })]);
    const v1 = (await own.generate('invoices', inv.id)).body.version;
    const v1Bytes = (await own.download('invoices', inv.id, v1.id)).bytes;
    const v1Snapshot = (await admin.query('SELECT snapshot FROM finance_document_pdfs WHERE id = $1', [v1.id])).rows[0].snapshot as DocumentSnapshot;

    // Everything that could leak into a later rendering changes:
    const b = (await own.branding()).body.branding;
    await own.patchBranding({ version: b.version, accentColor: '#B42318', footerText: 'New footer after issue', invoiceTitle: 'Tax invoice' });
    expect((await own.updateCustomer(custA, { addressLine1: '99 New Road' })).status).toBe(200);
    const settings = await settingsRoute.GET(req('GET', `/api/v1/b/${A.slug}/finance/settings`, { cookie: A.people.OWNER!.cookie }), ctx({ slug: A.slug })).then(json);
    await own.patchSettings({ version: settings.body.settings.version, sellerLegalName: 'Renamed Seller Ltd', paymentInstructions: 'New bank details' });
    const paid = await own.pay({ customerId: custA, amount: inv.total, receivedOn: '2026-11-15', method: 'BANK_TRANSFER', allocations: [{ invoiceId: inv.id, amount: inv.total }] });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);

    // …and the stored original does not.
    const again = await own.download('invoices', inv.id, v1.id);
    expect(again.bytes.equals(v1Bytes)).toBe(true);
    const listed = (await own.versions('invoices', inv.id)).body;
    expect(listed).toMatchObject({ eligible: true, versions: [{ id: v1.id, fileSha256: v1.fileSha256, versionNumber: 1 }] });
    expect((await own.generate('invoices', inv.id)).status).toBe(200); // original again: the same version, not a new one

    const v2res = await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'BRANDING_UPDATED', note: 'New title and colours', basedOnVersion: 1 });
    expect(v2res.status).toBe(201);
    const v2 = v2res.body.version;
    expect(v2).toMatchObject({ versionNumber: 2, reason: 'BRANDING_UPDATED', reasonNote: 'New title and colours', previousVersionId: v1.id, documentContentSha256: v1.documentContentSha256, fileName: `${inv.number}-v2.pdf` });
    const p2 = await readPdf((await own.download('invoices', inv.id, v2.id)).bytes);
    expect(p2.text).toContain('Tax invoice');
    expect(p2.text).toContain('New footer after issue');
    // The financial and recipient content is the content sealed at issue, in every version:
    expect(p2.text).toContain('1 Old Street');
    expect(p2.text).not.toContain('99 New Road');
    expect(p2.text).toContain('Harbour Studio Pty Ltd');
    expect(p2.text).not.toContain('Renamed Seller Ltd');
    expect(p2.text).toContain('BSB 000-000 Account 12345678');
    expect(p2.text).not.toMatch(/paid/i);
    const p1 = await readPdf(v1Bytes);
    expect(p1.text).not.toContain('New footer after issue');

    // Reproducible: rendering v1's stored snapshot again (same template and renderer) gives the same bytes.
    const rerendered = await renderDocument(v1Snapshot, null);
    expect(sha(rerendered.bytes)).toBe(v1.fileSha256);
    const audit = await audits(v2.id);
    expect(audit.map((a) => a.action)).toEqual(['finance.document_pdf.generated', 'finance.document_pdf.downloaded']);
    expect(audit[0]).toMatchObject({ actor_user_id: A.people.OWNER!.id, business_id: A.businessId });
    expect(audit[0].metadata).toMatchObject({ documentId: inv.id, kind: 'INVOICE', number: inv.number, versionNumber: '2', reason: 'BRANDING_UPDATED', hasNote: 'true', previousVersionId: v1.id, fileSha256: v2.fileSha256 });
    expect(JSON.stringify(audit[0].metadata)).not.toContain('New title and colours'); // never free text
  });

  it('enforces the version rules: original first, reasons, latest-version concurrency, and VOID marking', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 1 })).body.error).toBe('no_original');
    const v1 = (await own.generate('invoices', inv.id)).body.version;
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'OTHER', basedOnVersion: 1 })).status).toBe(400); // OTHER needs a note
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'ORIGINAL', basedOnVersion: 1 })).status).toBe(400);
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 2 })).body.error).toBe('stale');
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'OTHER', note: 'Customer asked for a copy', basedOnVersion: 1 })).status).toBe(201);
    expect((await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 1 })).body.error).toBe('stale');
    // Voiding the invoice does not touch stored versions; a version generated afterwards says VOID.
    expect((await own.void(inv.id, { version: inv.version, reason: 'Duplicate' })).status).toBe(200);
    const v3 = (await own.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 2 })).body.version;
    expect(v3).toMatchObject({ versionNumber: 3, documentStatus: 'VOID' });
    expect((await readPdf((await own.download('invoices', inv.id, v3.id)).bytes)).text).toContain('VOID');
    expect((await readPdf((await own.download('invoices', inv.id, v1.id)).bytes)).text).not.toContain('VOID');
  });

  it('holds the rules in the database too: eligibility, sequence, checksums and immutability', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    const v1 = (await own.generate('invoices', inv.id)).body.version;
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      const asApp = async (sql: string, params: unknown[] = []) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [A.businessId, A.people.OWNER!.id]);
          return await app.query(sql, params);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      const insert = (over: Record<string, unknown>) => {
        const row = {
          id: randomUUID(), business_id: A.businessId, document_id: inv.id, document_kind: 'INVOICE', version_number: 2, reason: 'RENDERING_CORRECTION',
          previous_version_id: v1.id, document_number: inv.number, document_status: 'ISSUED', document_content_sha256: inv.contentSha256, template_id: 'standard',
          template_version: 1, renderer: 'test', snapshot: '{}', snapshot_sha256: '0'.repeat(64), file_name: 'x.pdf', page_count: 1, byte_size: 1,
          file_sha256: '0'.repeat(64), file_data: Buffer.from('%PDF-1.7 tampered'), generated_by_id: A.people.OWNER!.id, ...over,
        };
        const cols = Object.keys(row);
        return asApp(`INSERT INTO finance_document_pdfs (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING byte_size, file_sha256, snapshot_sha256`, Object.values(row));
      };
      const ok = await insert({});
      // Size and checksums are the database's, whatever the client sent.
      expect(ok.rows[0]).toEqual({ byte_size: 17, file_sha256: sha(Buffer.from('%PDF-1.7 tampered')), snapshot_sha256: sha(Buffer.from('{}')) });
      await expect(insert({ document_number: 'INV-9999' })).rejects.toMatchObject({ code: 'FN019' });
      await expect(insert({ document_content_sha256: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'FN019' });
      await expect(insert({ version_number: 3 })).rejects.toMatchObject({ code: expect.stringMatching(/FN020|23514/) });
      await expect(insert({ previous_version_id: null })).rejects.toMatchObject({ code: expect.stringMatching(/FN020|23514/) });
      await expect(insert({ version_number: 1, reason: 'ORIGINAL', previous_version_id: null })).rejects.toMatchObject({ code: 'FN020' });
      await expect(insert({ generated_by_id: A.people.ADMIN!.id })).rejects.toThrow(/row-level security/);
      await expect(insert({ business_id: B.businessId })).rejects.toThrow(/row-level security|not eligible|violates/);
      await expect(asApp('UPDATE finance_document_pdfs SET reason_note = $1 WHERE id = $2', ['x', v1.id])).rejects.toThrow(/permission denied/);
      await expect(asApp('DELETE FROM finance_document_pdfs WHERE id = $1', [v1.id])).rejects.toThrow(/permission denied/);
      // A draft can never get a stored version.
      const draft = (await own.createInvoice({ customerId: custA, lines: [line()] })).body.document;
      await expect(insert({ document_id: draft.id, version_number: 1, reason: 'ORIGINAL', previous_version_id: null, document_status: 'DRAFT', document_number: 'x' }))
        .rejects.toMatchObject({ code: expect.stringMatching(/FN019|23514/) });
    } finally {
      await app.end();
    }
    await expect(admin.query('UPDATE finance_document_pdfs SET file_data = $1 WHERE id = $2', [Buffer.from('x'), v1.id])).rejects.toMatchObject({ code: 'FN021' });
  });

  it('refuses to serve stored bytes that no longer match their checksum', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    const v1 = (await own.generate('invoices', inv.id)).body.version;
    // Simulate storage corruption, bypassing the guards in an administrative session.
    await admin.query('BEGIN');
    await admin.query('SET LOCAL session_replication_role = replica');
    await admin.query('UPDATE finance_document_pdfs SET file_data = $1 WHERE id = $2', [Buffer.from('%PDF-1.7 corrupted'), v1.id]);
    await admin.query('COMMIT');
    const res = await own.download('invoices', inv.id, v1.id);
    expect(res.status).toBe(500);
    expect(res.json()).toEqual({ error: 'integrity_error' });
  });
});

describe('permissions, tenancy and identifiers', () => {
  it('applies the default role matrix: MEMBER has no access, MANAGER previews, generates and downloads, branding is OWNER/ADMIN', async () => {
    const inv = await issuedInvoice([line()]);
    const v = (await api(A.people.ADMIN!, A.slug).generate('invoices', inv.id)).body.version;
    const member = api(A.people.MEMBER!, A.slug);
    expect((await member.versions('invoices', inv.id)).status).toBe(403);
    expect((await member.generate('invoices', inv.id)).status).toBe(403);
    expect((await member.preview('invoices', inv.id, v.id)).status).toBe(403);
    expect((await member.download('invoices', inv.id, v.id)).status).toBe(403);
    const manager = api(A.people.MANAGER!, A.slug);
    expect((await manager.versions('invoices', inv.id)).status).toBe(200);
    expect((await manager.preview('invoices', inv.id, v.id)).status).toBe(200);
    expect((await manager.download('invoices', inv.id, v.id)).status).toBe(200);
    expect((await manager.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 1 })).status).toBe(201);
    expect((await manager.patchBranding({ version: 0, footerText: 'x' })).status).toBe(403);
  });

  it('distinguishes viewing records, previewing, generating and downloading', async () => {
    const inv = await issuedInvoice([line()]);
    const v = (await api(A.people.OWNER!, A.slug).generate('invoices', inv.id)).body.version;
    const m = api(A.people.MANAGER!, A.slug);
    custom.MANAGER = ['finance:read'];
    expect((await m.versions('invoices', inv.id)).status).toBe(200);
    expect((await m.version(inv.id, v.id)).status).toBe(200);
    expect((await m.preview('invoices', inv.id, v.id)).status).toBe(403);
    expect((await m.download('invoices', inv.id, v.id)).status).toBe(403);
    expect((await m.generate('invoices', inv.id)).status).toBe(403);
    custom.MANAGER = ['finance:read', 'finance:documents_preview'];
    const preview = await m.preview('invoices', inv.id, v.id);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-disposition')).toMatch(/^inline; /);
    expect((await m.download('invoices', inv.id, v.id)).status).toBe(403);
    custom.MANAGER = ['finance:read', 'finance:documents_download'];
    expect((await m.download('invoices', inv.id, v.id)).status).toBe(200);
    expect((await m.preview('invoices', inv.id, v.id)).status).toBe(403);
    // Previews are not audited; downloads are.
    const audit = (await audits(v.id)).map((a) => a.action);
    expect(audit).toEqual(['finance.document_pdf.generated', 'finance.document_pdf.downloaded']);
  });

  it('never crosses businesses: ids from another business, kind or document are 404, also at the database', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    const v = (await own.generate('invoices', inv.id)).body.version;
    const other = await issuedInvoice([line()]);
    const ownB = api(B.people.OWNER!, B.slug);
    // B's member asking under B's slug for A's ids:
    expect((await ownB.versions('invoices', inv.id)).status).toBe(404);
    expect((await ownB.generate('invoices', inv.id)).status).toBe(404);
    expect((await ownB.preview('invoices', inv.id, v.id)).status).toBe(404);
    expect((await ownB.download('invoices', inv.id, v.id)).status).toBe(404);
    expect((await ownB.draftPdf('invoices', inv.id)).status).toBe(404);
    // …and under A's slug, where B's owner is not a member:
    expect((await api(B.people.OWNER!, A.slug).download('invoices', inv.id, v.id)).status).toBe(404);
    // A version id under another document, or an invoice under the quotes path:
    expect((await own.download('invoices', other.id, v.id)).status).toBe(404);
    expect((await own.preview('quotes', inv.id, v.id)).status).toBe(404);
    expect((await own.versions('quotes', inv.id)).status).toBe(404);
    // At the database: B's context sees none of A's versions or assets.
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [B.businessId, B.people.OWNER!.id]);
      expect((await app.query('SELECT count(*)::int AS n FROM finance_document_pdfs WHERE id = $1', [v.id])).rows[0].n).toBe(0);
      expect((await app.query('SELECT count(*)::int AS n FROM finance_branding_assets WHERE business_id = $1', [A.businessId])).rows[0].n).toBe(0);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });

  it('answers malformed and unknown identifiers with 404, never 500', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    for (const [doc, ver] of [['not-a-uuid', randomUUID()], [inv.id, 'nope'], [inv.id, randomUUID()], [randomUUID(), randomUUID()], [inv.id, '../../etc/passwd']]) {
      const res = await own.download('invoices', doc!, ver!);
      expect(res.status, `${doc} ${ver}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
    expect((await own.generate('invoices', 'nope')).status).toBe(404);
    expect((await own.draftPdf('invoices', randomUUID())).status).toBe(404);
  });

  it('lets the desktop origin read the file name and checksum headers (CORS), and nobody else', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    const v = (await own.generate('invoices', inv.id)).body.version;
    const desktop = await own.download('invoices', inv.id, v.id, 'tauri://localhost');
    expect(desktop.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect(desktop.headers.get('access-control-expose-headers')).toBe('Content-Disposition, X-Document-Sha256');
  });
});

describe('concurrency, failure and file names', () => {
  it('creates exactly one original under concurrent requests, and one next version per base version', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    const results = await Promise.all(Array.from({ length: 6 }, () => own.generate('invoices', inv.id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.version.id)).size).toBe(1);
    const next = await Promise.all(Array.from({ length: 4 }, () => own.generate('invoices', inv.id, { mode: 'new_version', reason: 'RENDERING_CORRECTION', basedOnVersion: 1 })));
    expect(next.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    const rows = await admin.query('SELECT version_number FROM finance_document_pdfs WHERE document_id = $1 ORDER BY version_number', [inv.id]);
    expect(rows.rows.map((r) => r.version_number)).toEqual([1, 2]);
  });

  it('stores nothing when rendering fails and succeeds on retry', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const inv = await issuedInvoice([line()]);
    renderFailure.remaining = 1;
    const failed = await own.generate('invoices', inv.id);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: 'generation_failed' });
    expect((await admin.query('SELECT count(*)::int AS n FROM finance_document_pdfs WHERE document_id = $1', [inv.id])).rows[0].n).toBe(0);
    expect((await audits(inv.id)).map((a) => a.action)).not.toContain('finance.document_pdf.generated');
    const retried = await own.generate('invoices', inv.id);
    expect(retried.status).toBe(201);
    expect(retried.body.version.versionNumber).toBe(1);
  });

  it('builds safe, correctly encoded file names from any number prefix', async () => {
    const own = api(B.people.OWNER!, B.slug);
    const series = await seriesListRoute.GET(req('GET', `/api/v1/b/${B.slug}/finance/number-series`, { cookie: B.people.OWNER!.cookie }), ctx({ slug: B.slug })).then(json);
    const current = series.body.series.find((x: { kind: string }) => x.kind === 'INVOICE');
    expect((await own.patchSeries('invoice', { version: current.version, prefix: 'Rëch/nüng "Nr" ' })).status).toBe(200);
    const draft = await own.createInvoice({ customerId: custB, lines: [{ description: 'x', quantity: '1', unitPrice: '1' }] });
    const inv = (await own.issue('invoices', draft.body.document.id, { version: 1, dueDate: '2026-12-31' })).body.document;
    expect(inv.number).toMatch(/^Rëch\/nüng "Nr" \d{4}$/);
    const digits = inv.number.slice(-4);
    const v = (await own.generate('invoices', inv.id)).body.version;
    expect(v.fileName).toBe(`Rech_nung_Nr_${digits}.pdf`);
    const dl = await own.download('invoices', inv.id, v.id);
    const header = dl.headers.get('content-disposition')!;
    expect(header).toBe(`attachment; filename="Rech_nung_Nr_${digits}.pdf"; filename*=UTF-8''R%C3%ABch_n%C3%BCng%20_Nr_%20${digits}.pdf`);
    expect(header).not.toMatch(/[\r\n]/);
    expect(/^[\x20-\x7e]+$/.test(header)).toBe(true);
  });
});

describe('quote to invoice', () => {
  it('prints the source quote number on an invoice converted from it', async () => {
    const own = api(A.people.OWNER!, A.slug);
    const q = await own.createQuote({ customerId: custA, lines: [line()] });
    const quote = (await own.issue('quotes', q.body.document.id, { version: 1, issueDate: '2026-11-15' })).body.document;
    await own.accept(quote.id, { version: 2 });
    const conv = await own.convert(quote.id, { dueDate: '2026-12-31' });
    const inv = (await own.issue('invoices', conv.body.document.id, { version: 1, issueDate: '2026-11-16' })).body.document;
    const v = (await own.generate('invoices', inv.id)).body.version;
    const text = (await readPdf((await own.download('invoices', inv.id, v.id)).bytes)).text;
    expect(text).toContain('QUOTE REFERENCE');
    expect(text).toContain(quote.number);
    // The quote's own original stays a quote document.
    const qv = (await own.generate('quotes', quote.id)).body.version;
    expect(qv).toMatchObject({ documentKind: 'QUOTE', documentStatus: 'ACCEPTED' });
    expect((await own.versions('quotes', quote.id)).body.versions).toHaveLength(1);
  });
});
