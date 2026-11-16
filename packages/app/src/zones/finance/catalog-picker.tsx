import type { CatalogItem } from '@business-os/contracts';
import { useEffect, useId, useState } from 'react';
import { inputClass } from '../../shell/frame';
import { SearchError } from '../customer-picker';
import { useLoad } from '../use-load';
import { formatUnitPrice } from './catalog';
import { useFinance } from './env';

// Finance F7-B (docs/finance-catalog-f7b.md): choosing a product or service for a draft quote or
// invoice line. Only active, unarchived items are offered (status=active). Picking an item COPIES its
// values into a new line, which the person can then change; the server checks the item again when the
// draft is saved (this business, active, not archived, currency), and never stores a link to it.

/** The values a picked item starts a line with. Mirrors the server's lineDefaultsOf; the server decides on save. */
export function catalogLineStart(item: CatalogItem, documentCurrency: string, defaultTaxRateId: string, liveTaxRate: (id: string) => boolean) {
  const description = (item.description ? `${item.name}\n${item.description}` : item.name).slice(0, 1000);
  const priceFits = item.unitPrice !== null && item.currencyCode === documentCurrency;
  let taxRateId = '';
  let taxNote: string | null = null;
  if (item.taxMode === 'RATE' && item.taxRateId) {
    if (liveTaxRate(item.taxRateId)) taxRateId = item.taxRateId;
    else taxNote = 'This item\'s tax rate has been archived. Choose a tax for this line.';
  } else if (item.taxMode === 'BUSINESS_DEFAULT') {
    taxRateId = defaultTaxRateId;
  }
  return { description, unitPrice: priceFits ? item.unitPrice! : '', taxRateId, taxNote };
}

/** Why a picked item's price was not filled in, or null when it was. */
export function catalogPriceNote(item: Pick<CatalogItem, 'unitPrice' | 'currencyCode'>, documentCurrency: string): string | null {
  if (item.unitPrice === null) return `This item has no default price. Enter a price in ${documentCurrency}.`;
  if (item.currencyCode !== documentCurrency) return `This item's price is in ${item.currencyCode}. Enter a price in ${documentCurrency} (prices are never converted).`;
  return null;
}

/**
 * A searchable list of the catalog's active products and services. Keyboard and screen-reader
 * friendly: a labelled search box, a polite live region for the results, and one button per item.
 */
export function CatalogLinePicker({ documentCurrency, disabled, onPick, onClose }: {
  documentCurrency: string; disabled?: boolean; onPick: (item: CatalogItem) => void; onClose: () => void;
}) {
  const { client, slug, locale, onSessionEnded } = useFinance();
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useLoad(`pick-catalog|${slug}|${q}`, (signal) => client.catalogItems(slug, { q: q || undefined, status: 'active', limit: 8 }, signal));
  const items = results.state.status === 'done' && results.state.outcome.kind === 'ok' ? results.state.outcome.data.items : [];
  const failure = results.state.status === 'done' && results.state.outcome.kind !== 'ok' ? results.state.outcome : null;
  return (
    <section aria-labelledby={`${id}-title`} className="mt-4 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="text-sm font-semibold">Add a product or service</h3>
        <button type="button" onClick={onClose} className="rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          Close
        </button>
      </div>
      <label htmlFor={`${id}-q`} className="mt-3 block text-sm font-medium">Search the catalog</label>
      <input id={`${id}-q`} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, code or description" className={inputClass}
        aria-describedby={`${id}-hint`} autoComplete="off" maxLength={200} autoFocus />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
        Active items only. The item's values are copied into a new line, which you can change before saving.
      </p>
      <div aria-live="polite">
        {results.state.status !== 'done' ? <p className="mt-2 text-xs text-muted-foreground">Loading the catalog…</p> : failure ? (
          <SearchError outcome={failure} what="search the catalog" onRetry={results.reload} onSessionEnded={onSessionEnded} />
        ) : items.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">{q ? `No active products or services match “${q}”.` : 'There are no active products or services yet.'}</p>
        ) : (
          <ul aria-label="Matching products and services" className="mt-2 divide-y divide-border rounded-xl border border-border">
            {items.map((item) => {
              const note = item.unitPrice !== null && item.currencyCode !== documentCurrency ? `price in ${item.currencyCode}` : null;
              return (
                <li key={item.id}>
                  <button type="button" disabled={disabled} onClick={() => onPick(item)}
                    className="flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
                    <span>
                      <span className="font-medium">{item.name}</span>
                      {item.code ? <span className="ml-2 text-xs text-muted-foreground">{item.code}</span> : null}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatUnitPrice(item.unitPrice, item.currencyCode, locale)}{note ? ` (${note})` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
