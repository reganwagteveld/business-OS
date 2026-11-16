import type { FinanceDocumentKind } from '@business-os/contracts';
import { createContext, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { DocumentPath, FinanceClient } from '../../api/finance';

/** Every screen of the Finance Zone, held in memory (no URL routing). */
export type FinanceView =
  | { name: 'overview' }
  | { name: 'documents'; path: DocumentPath }
  | { name: 'document'; path: DocumentPath; id: string }
  | { name: 'document-new'; path: 'quotes' | 'invoices'; customerId?: string }
  | { name: 'document-edit'; path: DocumentPath; id: string }
  | { name: 'payments' }
  | { name: 'payment'; id: string }
  | { name: 'payment-new'; prefill?: PaymentPrefill }
  | { name: 'expenses' }
  | { name: 'expense'; id: string }
  | { name: 'expense-new' }
  | { name: 'expense-edit'; id: string }
  | { name: 'expense-payments' }
  | { name: 'expense-payment'; id: string }
  | { name: 'expense-payment-new'; expenseId?: string }
  | { name: 'settings'; tab?: SettingsTab }
  // F6-1: recurring invoices live under Invoices.
  | { name: 'recurring-list' }
  | { name: 'recurring'; id: string }
  | { name: 'recurring-new' }
  | { name: 'recurring-edit'; id: string }
  // F6-2: receivables ageing and customer statements as of a date.
  | { name: 'receivables' }
  | { name: 'statement'; customerId?: string; currencyCode?: string }
  // F7-A: the products and services catalog.
  | { name: 'catalog' }
  | { name: 'catalog-item'; id: string }
  | { name: 'catalog-new' };

export type SettingsTab = 'business' | 'numbering' | 'tax-rates' | 'categories' | 'documents';
export interface PaymentPrefill { customerId: string; currencyCode: string; invoiceId?: string; amount?: string }

/** The Zone's sections, the same ids as the registry's children (secondary navigation). */
export type FinanceSection = 'overview' | 'quotes' | 'invoices' | 'credit-notes' | 'payments' | 'receivables' | 'expenses' | 'catalog' | 'settings';

export function sectionOf(view: FinanceView): FinanceSection {
  switch (view.name) {
    case 'overview': return 'overview';
    case 'documents': case 'document': case 'document-edit': return view.path;
    case 'document-new': return view.path;
    case 'payments': case 'payment': case 'payment-new': return 'payments';
    case 'settings': return 'settings';
    case 'recurring-list': case 'recurring': case 'recurring-new': case 'recurring-edit': return 'invoices';
    case 'receivables': case 'statement': return 'receivables';
    case 'catalog': case 'catalog-item': case 'catalog-new': return 'catalog';
    default: return 'expenses';
  }
}

export function viewOfSection(section: string | undefined): FinanceView {
  switch (section) {
    case 'quotes': case 'invoices': case 'credit-notes': return { name: 'documents', path: section };
    case 'payments': return { name: 'payments' };
    case 'receivables': return { name: 'receivables' };
    case 'expenses': return { name: 'expenses' };
    case 'catalog': return { name: 'catalog' };
    case 'settings': return { name: 'settings' };
    default: return { name: 'overview' };
  }
}

export const PATH_KIND: Record<DocumentPath, FinanceDocumentKind> = { quotes: 'QUOTE', invoices: 'INVOICE', 'credit-notes': 'CREDIT_NOTE' };

export interface FinanceCan {
  /** finance:write: create and edit drafts, convert a quote, start a credit note. */
  write: boolean;
  /** finance:issue: issue, accept, decline, expire, void. */
  issue: boolean;
  /** finance:payments: record, allocate and reverse payments; apply credit. */
  payments: boolean;
  /** finance:expenses: expenses. */
  expenses: boolean;
  /** finance:manage: numbering, tax rates, categories, defaults. */
  manage: boolean;
  /** finance:billing (F6): create and change recurring invoice schedules. */
  billing: boolean;
  /** finance:catalog (F7-A): create, edit, deactivate, archive and restore catalog items. */
  catalog?: boolean;
  /** customers:read: search and name customers (held separately from any finance key). */
  readCustomers: boolean;
  /** F5 finance:documents_preview: preview a PDF (a draft's watermarked preview, or a stored version). */
  pdfPreview?: boolean;
  /** F5 finance:documents_generate: create the original PDF or a new version. */
  pdfGenerate?: boolean;
  /** F5 finance:documents_download: download a stored PDF. */
  pdfDownload?: boolean;
  /** F5 finance:documents_branding: change the logo, colour, titles, terms and footer. */
  branding?: boolean;
}

export interface FinanceEnv {
  client: FinanceClient;
  /** Present only with customers:read. Finance never reads customers without it. */
  customers: CustomersClient | null;
  slug: string; locale?: string; timeZone: string; currency: string; today: string;
  can: FinanceCan;
  go: (view: FinanceView, notice?: string | null) => void;
  /** Leave the current screen, asking first when a form holds unsaved changes. */
  leave: (action: () => void) => void;
  markDirty: (key: string, dirty: boolean) => void;
  onSessionEnded: () => void;
  /** Opens a customer in the Customers Zone (only with customers:read). */
  onOpenCustomer?: (customerId: string) => void;
  /** Live customer names for this business, fetched once per id (customers:read only). */
  names: CustomerNames;
}

const Ctx = createContext<FinanceEnv | null>(null);
export const FinanceEnvProvider = Ctx.Provider;
export function useFinance(): FinanceEnv {
  const env = useContext(Ctx);
  if (!env) throw new Error('Finance screens must be rendered inside the Finance Zone');
  return env;
}

export interface CustomerNames {
  /** The live name, `undefined` while unknown, or null when it cannot be read. */
  get: (id: string) => string | null | undefined;
  request: (ids: readonly string[]) => void;
}

/**
 * Customer names for lists, read from the Customers API only when the person holds customers:read.
 * The cache lives inside the Zone, which is remounted per business, so one business's names are never
 * shown under another. Issued documents show their own bill-to snapshot instead (finance:read).
 */
export function useCustomerNames(customers: CustomersClient | null, slug: string): CustomerNames {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());
  const alive = useRef(true);
  // Set on every mount, not only the first: React Strict Mode runs effects, their cleanup and the effects
  // again, so a flag cleared only in cleanup would stay false and drop every name that arrives later.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return {
    get: (id) => names[id],
    request: (ids) => {
      if (!customers) return;
      for (const id of new Set(ids)) {
        if (asked.current.has(id)) continue;
        asked.current.add(id);
        void customers.get(slug, id).then((out) => {
          if (alive.current) setNames((n) => ({ ...n, [id]: out.kind === 'ok' ? out.data.displayName : null }));
        }, () => undefined);
      }
    },
  };
}

/** Ask for the names of these customers once they are on screen. */
export function useRequestNames(ids: readonly string[]) {
  const { names } = useFinance();
  const key = [...new Set(ids)].sort().join(',');
  const ask = useEffectEvent((list: string[]) => names.request(list));
  useEffect(() => {
    if (key) ask(key.split(','));
  }, [key]);
}
