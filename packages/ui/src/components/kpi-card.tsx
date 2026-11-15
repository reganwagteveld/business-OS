import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Card } from './card';
import { Skeleton } from './loading';

const TREND = { up: 'text-success', down: 'text-destructive', neutral: 'text-muted-foreground' } as const;

/**
 * A key figure for any Zone (Reporting R1): a label, one or more values (one per currency: amounts in
 * different currencies are never added), an optional change against a comparison period, and a short
 * note on what the figure means. The change is text ("+12.5% vs previous period"), so the trend never
 * relies on colour alone. `state` covers loading and figures this person cannot see.
 */
export function KpiCard({ label, values, change, trend = 'neutral', note, state = 'ready', unavailableText = 'Not available', className, action }: {
  label: ReactNode;
  /** One line per value, for example one per currency. Empty shows "No data". */
  values?: { key: string; text: ReactNode; caption?: ReactNode }[];
  change?: ReactNode;
  trend?: keyof typeof TREND;
  /** What the figure is (for example "Issued invoices, by issue date"). */
  note?: ReactNode;
  state?: 'ready' | 'loading' | 'unavailable';
  unavailableText?: ReactNode;
  className?: string;
  /** Optional control, for example a "Show records" button. */
  action?: ReactNode;
}) {
  return (
    <Card className={cn('flex min-w-0 flex-col p-5', className)} aria-busy={state === 'loading' || undefined}>
      <p className="text-sm text-muted-foreground">{label}</p>
      {state === 'loading' ? (
        <div className="mt-2 space-y-2" role="status">
          <span className="sr-only">Loading</span>
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-3 w-24" />
        </div>
      ) : state === 'unavailable' ? (
        <p className="mt-2 text-sm text-muted-foreground">{unavailableText}</p>
      ) : (
        <>
          {values && values.length > 0 ? (
            <ul className="mt-2 space-y-0.5">
              {values.map((v) => (
                <li key={v.key} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-2xl font-semibold tracking-tight tabular-nums break-all">{v.text}</span>
                  {v.caption ? <span className="text-xs text-muted-foreground">{v.caption}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-2xl font-semibold tracking-tight text-muted-foreground">No data</p>
          )}
          {change ? <p className={cn('mt-1 text-xs font-medium', TREND[trend])}>{change}</p> : null}
        </>
      )}
      {note ? <p className="mt-3 text-xs text-muted-foreground">{note}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </Card>
  );
}
