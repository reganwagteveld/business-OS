import { Card, CardContent, CardHeader, CardTitle } from '@business-os/ui';
import type { ReactNode } from 'react';

/** A labelled list of facts. A missing value reads "Not recorded"; nothing is invented. */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
          <dd className="mt-1 text-sm [overflow-wrap:anywhere]">{value === null || value === undefined || value === '' ? <span className="text-muted-foreground">Not recorded</span> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
