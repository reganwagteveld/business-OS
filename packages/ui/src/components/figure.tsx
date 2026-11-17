import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Skeleton } from './loading';
import { Marker, type MarkerTone } from './pixel-marker';

// Static class strings so Tailwind finds them. Under 640 px every strip shows two figures per row.
const COLUMNS = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-4 lg:grid-cols-5',
} as const;

/**
 * A band of 2 to 5 figures between two rules, with a rule between figures (V2-B2 §6.7). Replaces
 * figure cards: no box, no shadow. The figures form a description list, so each label names its value
 * for screen readers. Pass `aria-label` (or `aria-labelledby`) when a heading above does not already
 * name the band; the strip then becomes a labelled group.
 */
export function FigureStrip({ columns = 4, className, children, ...props }: ComponentProps<'div'> & { columns?: keyof typeof COLUMNS }) {
  const labelled = props['aria-label'] != null || props['aria-labelledby'] != null;
  return (
    // The outer box clips the first cell's left rule and the first row's top rule, so rules appear only between figures.
    <div role={labelled ? 'group' : undefined} className={cn('overflow-hidden border-y border-line', className)} {...props}>
      <dl className={cn('-mt-px -ml-px grid grid-cols-2', COLUMNS[columns])}>{children}</dl>
    </div>
  );
}

/**
 * One figure in a `FigureStrip`: a label (optionally with a status marker), the value, an optional
 * second value in another currency on its own line (currencies are never added together) and a note
 * saying what period or "as of" date it covers. Values are tabular. `size="display"` is for Home only.
 */
export function Figure({ label, value, secondaryValue, note, marker, hollow, size = 'default', state = 'ready', unavailableText = 'Not available', className }: {
  label: ReactNode;
  value?: ReactNode;
  /** The same figure in a second currency, shown as its own line. */
  secondaryValue?: ReactNode;
  /** Period, comparison or "as of" date. */
  note?: ReactNode;
  marker?: MarkerTone;
  hollow?: boolean;
  size?: 'default' | 'display';
  state?: 'ready' | 'loading' | 'unavailable';
  unavailableText?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 border-t border-l border-line px-4 py-3', className)} aria-busy={state === 'loading' || undefined}>
      <dt className="flex items-center gap-1.5 text-caption text-fg-muted">
        {marker && <Marker tone={marker} hollow={hollow} />}
        {label}
      </dt>
      <dd className="mt-1">
        {state === 'loading' ? (
          <div role="status">
            <span className="sr-only">Loading</span>
            <Skeleton className="h-7 w-24 rounded-sm" />
          </div>
        ) : state === 'unavailable' ? (
          <span className="block text-small text-fg-muted">{unavailableText}</span>
        ) : (
          <>
            <span className={cn('block font-semibold tabular-nums break-words', size === 'display' ? 'text-display' : 'text-title')}>{value ?? '—'}</span>
            {secondaryValue != null && <span className="block text-small font-semibold tabular-nums">{secondaryValue}</span>}
          </>
        )}
        {note != null && <span className="mt-0.5 block text-caption text-fg-subtle">{note}</span>}
      </dd>
    </div>
  );
}
