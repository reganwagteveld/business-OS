// @vitest-environment jsdom
// Finance F5: the PDF card on quotes and invoices, and the Documents settings tab, against an in-memory
// API. The real Finance client and shared contracts sit in front of it, so every request body is checked
// (strict) and every JSON response is parsed with the contract. Files come back as real Blob responses.
import {
  CreateDocumentPdfVersionRequest, DocumentBrandingResponse, DocumentPdfVersionResponse, ListDocumentPdfVersionsResponse, UpdateDocumentBrandingRequest,
  UploadBrandingLogoRequest, type DocumentBranding, type DocumentPdfVersion, type FinanceDocument,
} from '@business-os/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomersClient, createFinanceClient, type BusinessContext } from '../src';
import { createRequester } from '../src/api/http';
import { FinanceZone } from '../src/zones/finance/finance-zone';
import { customer } from './support/fake-api';
import { openPdf } from '../src/zones/finance/pdf-render';
import { createFakeFinance, doc, financeData, issued, NOW, type FinanceData } from './support/fake-finance';

// PDF.js needs a real canvas, which jsdom does not have. The renderer is replaced here, and the real one
// was checked in a real browser under the production CSP (see the PR). These tests check what the viewer does
// with it: draw every page, release it on close, and say so clearly when it fails.
vi.mock('../src/zones/finance/pdf-render', () => ({ openPdf: vi.fn() }));
const drawn: { bytes: string; pages: number[]; destroyed: boolean }[] = [];
function renderOk(pageCount = 2) {
  vi.mocked(openPdf).mockImplementation(async (bytes) => {
    const entry = { bytes: new TextDecoder().decode(bytes), pages: [] as number[], destroyed: false };
    drawn.push(entry);
    return {
      pageCount,
      drawPage: async (n) => void entry.pages.push(n),
      destroy: async () => void (entry.destroyed = true),
    };
  });
}

const BASE = 'https://api.test';
const PDF = ['finance:documents_preview', 'finance:documents_generate', 'finance:documents_download'];
const OWNER = ['finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage', 'finance:documents_branding', 'customers:read', ...PDF];
const READER = ['finance:read'];
const ctx = (permissions: string[]): BusinessContext => ({
  business: { slug: 'alpha', name: 'Alpha Plumbing', countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  membership: { id: randomUUID(), role: 'OWNER', permissions },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pdfResponse = (sha = 'f'.repeat(64), unsupported?: boolean) => new Response(new TextEncoder().encode('%PDF-1.7 test'), {
  status: 200, headers: { 'content-type': 'application/pdf', 'x-document-sha256': sha, ...(unsupported === undefined ? {} : { 'x-unsupported-characters': String(unsupported) }) },
});
const heading = (name: string | RegExp) => screen.findByRole('heading', { name, level: 1 });

function versionOf(d: FinanceDocument, n: number, over: Partial<DocumentPdfVersion> = {}): DocumentPdfVersion {
  const id = randomUUID();
  const sha = n.toString(16).padStart(64, '0');
  return {
    id, documentId: d.id, documentKind: d.kind as 'QUOTE' | 'INVOICE', versionNumber: n, reason: n === 1 ? 'ORIGINAL' : 'BRANDING_UPDATED', reasonNote: null,
    previousVersionId: null, documentNumber: d.number!, documentStatus: d.status, documentContentSha256: 'a'.repeat(64), templateId: 'standard', templateVersion: 1,
    renderer: 'pdfkit@0.20.2', snapshotSha256: 'b'.repeat(64), logoAssetId: null, fileName: `${d.number}${n > 1 ? `-v${n}` : ''}.pdf`, contentType: 'application/pdf',
    pageCount: 1, byteSize: 18_000, fileSha256: sha, generatedById: randomUUID(), createdAt: NOW, reference: { type: 'finance_document_pdf', id, sha256: sha },
    unsupportedCharacters: false, ...over,
  };
}

const brandingOf = (over: Partial<DocumentBranding> = {}): DocumentBranding => ({
  accentColor: '#1F4B99', footerText: null, invoiceTitle: null, invoiceTerms: null, quoteTitle: null, quoteTerms: null, templateId: 'standard',
  defaultTitles: { INVOICE: 'Invoice', QUOTE: 'Quote' }, logo: null, version: 0, updatedAt: null, ...over,
});

interface Files {
  versions: Map<string, DocumentPdfVersion[]>;
  branding: DocumentBranding;
  calls: { method: string; path: string; body: unknown; accept?: string }[];
  /** One-off overrides: return a Response to answer the next matching call. */
  next: ((method: string, path: string) => Response | undefined)[];
}

function setup(o: { data?: FinanceData; permissions?: string[]; section?: string; target?: string; files?: Partial<Files> } = {}) {
  const data = o.data ?? financeData();
  const api = createFakeFinance({ alpha: data });
  const files: Files = { versions: new Map(), branding: brandingOf(), calls: [], next: [], ...o.files };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/api/v1/b/alpha/finance', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const accept = (init?.headers as Record<string, string> | undefined)?.accept;
    let m: RegExpExecArray | null;
    for (let i = 0; i < files.next.length; i++) {
      const r = files.next[i]!(method, path);
      if (r) {
        files.next.splice(i, 1);
        return r;
      }
    }
    const isF5 = /\/(pdf-versions|draft-pdf)/.test(path) || path.startsWith('/document-branding');
    if (!isF5) return api.fetch(input, init);
    files.calls.push({ method, path, body, accept });
    if ((m = /^\/(quotes|invoices)\/([^/]+)\/draft-pdf$/.exec(path))) {
      const d = data.documents.find((x) => x.id === m![2])!;
      return pdfResponse(undefined, d.lines.some((l) => /[\u3040-\u9fff\u0590-\u05ff]/.test(l.description)));
    }
    if ((m = /^\/(quotes|invoices)\/([^/]+)\/pdf-versions$/.exec(path))) {
      const d = data.documents.find((x) => x.id === m![2])!;
      const list = files.versions.get(d.id) ?? [];
      if (method === 'GET') return json(200, ListDocumentPdfVersionsResponse.parse({ eligible: d.status !== 'DRAFT' && !!d.number, versions: [...list].reverse() })); // newest first, as the API does
      const input = CreateDocumentPdfVersionRequest.parse(body);
      if (!list.length) return json(409, { error: 'no_original' });
      if (input.basedOnVersion !== list.length) return json(409, { error: 'stale' });
      const v = versionOf(d, list.length + 1, { reason: input.reason, reasonNote: input.note ?? null, previousVersionId: list[list.length - 1]!.id });
      list.push(v);
      return json(201, DocumentPdfVersionResponse.parse({ version: v }));
    }
    if ((m = /^\/(quotes|invoices)\/([^/]+)\/pdf-versions\/([^/]+)\/(preview|download)$/.exec(path))) return pdfResponse();
    if (path === '/document-branding' && method === 'GET') return json(200, DocumentBrandingResponse.parse({ branding: files.branding }));
    if (path === '/document-branding' && method === 'PATCH') {
      const input = UpdateDocumentBrandingRequest.parse(body);
      if (input.version !== files.branding.version) return json(409, { error: 'stale' });
      const { logoAssetId, ...fields } = input;
      const rest = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'version'));
      files.branding = { ...files.branding, ...rest, ...(logoAssetId === null ? { logo: null } : {}), version: files.branding.version + 1, updatedAt: NOW };
      return json(200, { branding: files.branding });
    }
    if (path === '/document-branding/logo' && method === 'POST') {
      const input = UploadBrandingLogoRequest.parse(body);
      files.branding = { ...files.branding, version: files.branding.version + 1, logo: { id: randomUUID(), contentType: input.contentType, byteSize: 100, width: 40, height: 20, sha256: 'c'.repeat(64), createdAt: NOW } };
      return json(201, { branding: files.branding });
    }
    if (path === '/document-branding/logo') return new Response(new TextEncoder().encode('png'), { status: 200, headers: { 'content-type': 'image/png' } });
    return json(404, { error: 'not_found' });
  }) as typeof globalThis.fetch;
  const finance = createFinanceClient(BASE, { kind: 'cookie' }, fetch);
  const customers = createCustomersClient(BASE, { kind: 'cookie' }, fetch);
  const permissions = o.permissions ?? OWNER;
  const handlers = { onHome: vi.fn(), onSwitch: vi.fn(), onSignOut: vi.fn(), onSessionEnded: vi.fn(), onSection: vi.fn(), onOpenCustomer: vi.fn() };
  render(
    <FinanceZone key="alpha" client={finance} customers={permissions.includes('customers:read') ? customers : undefined} context={ctx(permissions)} userLabel="Ada"
      section={o.section} initialTarget={o.target} {...handlers} />,
  );
  return { data, files, handlers, user: userEvent.setup() };
}

let clicked: { download: string; href: string; target?: string }[] = [];
beforeEach(() => {
  clicked = [];
  drawn.length = 0;
  renderOk();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:https://app.test/${++n}`);
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href, ...(this.target ? { target: this.target } : {}) });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('F5 finance client files', () => {
  it('fetches bytes with credentials, reports JSON errors as outcomes, and refuses an unexpected content type', async () => {
    const seen: RequestInit[] = [];
    const responses = [
      new Response(new TextEncoder().encode('%PDF'), { status: 200, headers: { 'content-type': 'application/pdf', 'x-document-sha256': 'e'.repeat(64) } }),
      json(404, { error: 'not_found' }),
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      json(503, { error: 'generation_failed' }),
    ];
    const fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init!);
      return responses.shift()!;
    }) as typeof globalThis.fetch;
    const client = createFinanceClient(BASE, { kind: 'bearer', getToken: async () => 'tok' } as never, fetch);
    const ok = await client.pdfFile('alpha', 'invoices', 'i', 'v', 'download');
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') expect(ok.data.sha256).toBe('e'.repeat(64));
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((seen[0]!.headers as Record<string, string>).accept).toContain('application/pdf');
    expect((await client.pdfFile('alpha', 'invoices', 'i', 'v', 'preview')).kind).toBe('not_found');
    expect((await client.draftPdf('alpha', 'quotes', 'q')).kind).toBe('invalid');
    expect(await client.draftPdf('alpha', 'quotes', 'q')).toEqual({ kind: 'failed', status: 503 });
  });

  it('a signed-out desktop sends nothing', async () => {
    const fetch = vi.fn();
    const r = createRequester(BASE, { kind: 'bearer', getToken: async () => null } as never, fetch as never);
    expect(await r.requestFile('/x', 'application/pdf')).toEqual({ kind: 'response', status: 401, json: undefined });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks a new version request against the contract before sending (OTHER needs a note)', async () => {
    const fetch = vi.fn();
    const client = createFinanceClient(BASE, { kind: 'cookie' }, fetch as never);
    const out = await client.createPdfVersion('alpha', 'invoices', randomUUID(), { mode: 'new_version', reason: 'OTHER', note: '', basedOnVersion: 1 });
    expect(out.kind).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('PDF card on a quote or invoice', () => {
  it('an issued invoice shows the original made at issue: Preview draws its pages, Download saves it under its file name, nothing is generated', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const inv = issued('INVOICE', acme, 'INV-0007', { amount: '100.00' });
    const files: Partial<Files> = { versions: new Map([[inv.id, [versionOf(inv, 1)]]]) };
    const { files: f, user } = setup({ data: financeData({ customers: [acme], documents: [inv] }), section: 'invoices', target: `invoice:${inv.id}`, files });
    await heading('INV-0007');
    const table = await screen.findByRole('table', { name: 'PDF versions' });
    expect(within(table).getByText('Original')).toBeTruthy();
    expect(within(table).getByText('Made when issued')).toBeTruthy();
    expect(screen.getByText(/The original was made when this invoice was issued/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Preview PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('INV-0007.pdf')).toBeTruthy();
    // The pages are drawn from the bytes the server sent, not handed to the browser's PDF viewer in a frame.
    expect(await within(dialog).findByRole('img', { name: 'INV-0007 · version 1, page 2 of 2' })).toBeTruthy();
    await waitFor(() => expect(drawn).toEqual([{ bytes: '%PDF-1.7 test', pages: [1, 2], destroyed: false }]));
    expect(dialog.querySelector('iframe, object, embed')).toBeNull();
    expect(f.calls.some((c) => c.path.endsWith('/preview') && c.accept?.includes('application/pdf'))).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(drawn[0]!.destroyed).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await screen.findByText('Downloaded INV-0007.pdf.');
    expect(clicked).toEqual([{ download: 'INV-0007.pdf', href: expect.stringMatching(/^blob:/) }]);
    expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(0); // viewing never generates anything
    // Nothing suggests the document went anywhere: the only mention of sending says it did not happen.
    expect(document.body.textContent!.replace('does not send it to anyone', '')).not.toMatch(/\bsent\b|\bsend\b|emailed|delivered/i);
  });

  it('an invoice issued before PDFs were kept says it has no original, and offers no PDF actions', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const inv = issued('INVOICE', acme, 'INV-0001');
    setup({ data: financeData({ customers: [acme], documents: [inv] }), section: 'invoices', target: `invoice:${inv.id}` });
    await heading('INV-0001');
    expect(await screen.findByText('This invoice was issued before PDFs were kept, so it has no original PDF.')).toBeTruthy();
    for (const name of ['Preview PDF', 'Download PDF', 'New version']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('flags characters the fonts cannot show: on the draft preview before issuing, and on stored versions', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const d = doc('INVOICE', { customerId: acme.id });
    d.lines[0]!.description = 'Translation 翻訳';
    const inv = issued('INVOICE', acme, 'INV-0021');
    const files: Partial<Files> = { versions: new Map([[inv.id, [versionOf(inv, 1, { unsupportedCharacters: true })]]]) };
    const { user } = setup({ data: financeData({ customers: [acme], documents: [d, inv] }), section: 'invoices', target: `invoice:${d.id}`, files });
    await heading('Draft invoice');
    await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/They are printed as □. Check the PDF before you share it./)).toBeTruthy();
    cleanup();
    setup({ data: financeData({ customers: [acme], documents: [inv] }), section: 'invoices', target: `invoice:${inv.id}`, files });
    await heading('INV-0021');
    expect(await screen.findByText('Some characters shown as □')).toBeTruthy();
    expect(screen.getByText(/They are printed as □/)).toBeTruthy();
  });

  it('a new version needs a reason (a note for Other), keeps the earlier ones, and a stale base offers a reload', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const q = issued('QUOTE', acme, 'QUO-0003');
    const files: Partial<Files> = { versions: new Map([[q.id, [versionOf(q, 1)]]]) };
    const { files: f, user } = setup({ data: financeData({ customers: [acme], documents: [q] }), section: 'quotes', target: `quote:${q.id}`, files });
    await heading('QUO-0003');
    await user.click(await screen.findByRole('button', { name: 'New version' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'OTHER');
    expect((within(dialog).getByRole('button', { name: 'Create version 2' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Note'), 'Corrected the address layout');
    await user.click(within(dialog).getByRole('button', { name: 'Create version 2' }));
    await screen.findByText('Version 2 was created. Earlier versions are unchanged.');
    const table = screen.getByRole('table', { name: 'PDF versions' });
    expect(within(table).getByText('Original')).toBeTruthy();
    expect(within(table).getByText('Corrected the address layout')).toBeTruthy();
    expect(within(table).getByText('Latest')).toBeTruthy();
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ mode: 'new_version', reason: 'OTHER', note: 'Corrected the address layout', basedOnVersion: 1 });
    // Someone else adds version 3 meanwhile: our request based on 2 is refused as stale.
    f.versions!.get(q.id)!.push(versionOf(q, 3));
    await user.click(screen.getByRole('button', { name: 'New version' }));
    const again = await screen.findByRole('dialog');
    await user.click(within(again).getByRole('button', { name: 'Create version 3' }));
    expect(await within(again).findByText(/Someone else created a version since you opened this/)).toBeTruthy();
    await user.click(within(again).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'PDF versions' })).getByText('v3')).toBeTruthy());
  });

  it('a draft has a watermarked preview only, and nothing is stored', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const d = doc('INVOICE', { customerId: acme.id });
    const { files, user } = setup({ data: financeData({ customers: [acme], documents: [d] }), section: 'invoices', target: `invoice:${d.id}` });
    await heading('Draft invoice');
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/marked DRAFT and is not kept/)).toBeTruthy();
    expect(await within(dialog).findByRole('img', { name: 'Draft invoice preview, page 1 of 2' })).toBeTruthy();
    // A draft preview can be opened in a tab (the same bytes), but there is no download of a draft.
    expect(within(dialog).queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Open in new tab' })).toBeTruthy();
    expect(files.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /invoices/${d.id}/draft-pdf`]);
  });

  it('issuing says the original PDF is made too, and a failed PDF leaves the draft unissued with a clear message', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const d = doc('INVOICE', { customerId: acme.id, dueDate: '2026-12-15' });
    const { user } = setup({ data: financeData({ customers: [acme], documents: [d] }), section: 'invoices', target: `invoice:${d.id}`,
      files: { next: [(method, path) => (method === 'POST' && path.endsWith('/issue') ? json(503, { error: 'generation_failed' }) : undefined)] } });
    await heading('Draft invoice');
    await user.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Its original PDF is made and kept at the same time/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));
    expect(await within(dialog).findByText(/could not finish this just now, so nothing was changed/)).toBeTruthy();
    // A second attempt goes through (the fake issues it).
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('permissions: a reader sees no PDF card; preview-only can preview but not generate or download', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const inv = issued('INVOICE', acme, 'INV-0011');
    const data = financeData({ customers: [acme], documents: [inv] });
    const { files } = setup({ data, permissions: READER, section: 'invoices', target: `invoice:${inv.id}` });
    await heading('INV-0011');
    expect(screen.queryByRole('heading', { name: 'PDF' })).toBeNull();
    expect(files.calls).toHaveLength(0);
    cleanup();
    const second = setup({ data, permissions: ['finance:read', 'finance:documents_preview'], section: 'invoices', target: `invoice:${inv.id}`,
      files: { versions: new Map([[inv.id, [versionOf(inv, 1)]]]) } });
    await heading('INV-0011');
    expect(await screen.findByRole('button', { name: 'Preview PDF' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Download version/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New version' })).toBeNull();
    expect(second.files.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('credit notes have no PDF card in F5', async () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const cn = issued('CREDIT_NOTE', acme, 'CN-0001');
    const { files } = setup({ data: financeData({ customers: [acme], documents: [cn] }), section: 'credit-notes', target: `credit-note:${cn.id}` });
    await screen.findAllByText(/CN-0001/);
    expect(screen.queryByRole('heading', { name: 'PDF' })).toBeNull();
    expect(files.calls).toHaveLength(0);
  });
});

describe('PDF preview fallbacks (Safari showed an empty frame)', () => {
  const draftSetup = () => {
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const q = doc('QUOTE', { customerId: acme.id });
    return { q, data: financeData({ customers: [acme], documents: [q] }) };
  };

  it('when the pages cannot be drawn, says so and offers a new tab instead of an empty panel; Try again draws afresh', async () => {
    vi.mocked(openPdf).mockRejectedValueOnce(new Error('cannot draw'));
    const { q, data } = draftSetup();
    const { files, user } = setup({ data, section: 'quotes', target: `quote:${q.id}` });
    await heading('Draft quote');
    await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
    const dialog = await screen.findByRole('dialog');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/The PDF was made, but this browser could not show it here. Open it in a new tab instead./);
    await user.click(within(dialog).getByRole('button', { name: 'Open in new tab' }));
    expect(clicked).toEqual([{ download: '', href: expect.stringMatching(/^blob:/), target: '_blank' }]);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('img', { name: 'Draft quote preview, page 1 of 2' })).toBeTruthy();
    // Neither the new tab nor the second attempt asked the server again: one preview, one audit entry.
    expect(files.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /quotes/${q.id}/draft-pdf`]);
  });

  it('an issued version that cannot be drawn offers the audited download as well as a new tab', async () => {
    vi.mocked(openPdf).mockImplementationOnce(async () => ({ pageCount: 1, drawPage: async () => { throw new Error('canvas'); }, destroy: async () => undefined }));
    const acme = customer({ displayName: 'Acme Pty Ltd' });
    const inv = issued('INVOICE', acme, 'INV-0031');
    const { files, user } = setup({ data: financeData({ customers: [acme], documents: [inv] }), section: 'invoices', target: `invoice:${inv.id}`,
      files: { versions: new Map([[inv.id, [versionOf(inv, 1)]]]) } });
    await heading('INV-0031');
    await user.click(await screen.findByRole('button', { name: 'Preview PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Open it in a new tab or download it instead./);
    await user.click(within(dialog).getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(clicked).toEqual([{ download: 'INV-0031.pdf', href: expect.stringMatching(/^blob:/) }]));
    expect(files.calls.map((c) => c.path.split('/').pop())).toEqual(['pdf-versions', 'preview', 'download']);
  });

  it('a PDF that fails to generate shows the reason and Try again, never a blank panel', async () => {
    const { q, data } = draftSetup();
    const { files, user } = setup({ data, section: 'quotes', target: `quote:${q.id}`,
      files: { next: [(method, path) => (path.endsWith('/draft-pdf') ? json(503, { error: 'generation_failed' }) : undefined)] } });
    await heading('Draft quote');
    await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/The PDF could not be made right now. Nothing was stored./);
    expect(within(dialog).queryByRole('button', { name: 'Open in new tab' })).toBeNull();
    expect(drawn).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByRole('img', { name: 'Draft quote preview, page 2 of 2' })).toBeTruthy();
    expect(files.calls.filter((c) => c.path.endsWith('/draft-pdf'))).toHaveLength(1); // the 503 answered by the override is not logged as a call
  });

  it('a response that is not a PDF is refused before anything is drawn', async () => {
    const { q, data } = draftSetup();
    const { user } = setup({ data, section: 'quotes', target: `quote:${q.id}`,
      files: { next: [(method, path) => (path.endsWith('/draft-pdf') ? new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) : undefined)] } });
    await heading('Draft quote');
    await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/sent back something that is not a PDF/);
    expect(drawn).toHaveLength(0);
  });

  it('inside the desktop app there is no new-tab button (its web view opens no tabs)', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      vi.mocked(openPdf).mockRejectedValueOnce(new Error('cannot draw'));
      const { q, data } = draftSetup();
      const { user } = setup({ data, section: 'quotes', target: `quote:${q.id}` });
      await heading('Draft quote');
      await user.click(await screen.findByRole('button', { name: 'Preview draft PDF' }));
      const dialog = await screen.findByRole('dialog');
      expect((await within(dialog).findByRole('alert')).textContent).toMatch(/this app could not show it here/);
      expect(within(dialog).queryByRole('button', { name: 'Open in new tab' })).toBeNull();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});

describe('Documents settings', () => {
  it('an owner changes the colour and titles; an invalid colour cannot be saved; a large logo is refused before upload', async () => {
    const { files, user } = setup({ section: 'settings' });
    await heading('Business details');
    await user.click(screen.getByRole('button', { name: 'Documents' }));
    await heading('Documents');
    const colour = await screen.findByLabelText('Accent colour');
    await user.clear(colour);
    await user.type(colour, 'blue');
    expect((screen.getByRole('button', { name: 'Save document settings' }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(colour);
    await user.type(colour, '#0a7d4f');
    const titles = screen.getAllByLabelText('Title');
    await user.type(titles[0]!, 'Tax invoice');
    await user.click(screen.getByRole('button', { name: 'Save document settings' }));
    await screen.findByText(/Document settings saved. PDFs made from now on use them. PDFs already kept do not change./);
    expect(files.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ version: 0, accentColor: '#0A7D4F', invoiceTitle: 'Tax invoice' });
    const big = new File([new Uint8Array(600 * 1024)], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose a logo image'), big);
    expect(await screen.findByText(/larger than 512 KB/)).toBeTruthy();
    expect(files.calls.some((c) => c.path === '/document-branding/logo' && c.method === 'POST')).toBe(false);
    const small = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Choose a logo image'), small);
    await screen.findByText('Logo uploaded. PDFs made from now on show it.');
    const upload = files.calls.find((c) => c.path === '/document-branding/logo' && c.method === 'POST')!;
    expect(upload.body).toEqual({ version: 1, contentType: 'image/png', dataBase64: 'iVBORw==' });
    expect(await screen.findByAltText('Current logo')).toBeTruthy();
  });

  it('without the branding permission the tab is read-only', async () => {
    setup({ permissions: ['finance:read', 'finance:manage'], section: 'settings' });
    await heading('Business details');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Documents' }));
    await heading('Documents');
    expect(await screen.findByText(/Only owners and admins can change them/)).toBeTruthy();
    expect((await screen.findByLabelText('Accent colour') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save document settings' })).toBeNull();
    expect(screen.queryByLabelText('Choose a logo image')).toBeNull();
  });
});

