import { cn } from '@business-os/ui';
import type { ReactNode } from 'react';

/** A read-only view: labelled values separated by hairline rules, not a disabled form. Empty values say so. */
export function Facts({ items, className }: { items: readonly { label: string; value: ReactNode; hint?: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('border-t border-line', className)}>
      {items.map((item) => (
        <div key={item.label} className="grid gap-1 border-b border-line py-3 sm:grid-cols-[14rem_1fr] sm:gap-6">
          <dt className="text-small text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 text-body break-words">
            {item.value === null || item.value === undefined || item.value === '' ? <span className="text-fg-subtle">Not set</span> : item.value}
            {item.hint ? <span className="mt-0.5 block text-caption text-fg-subtle">{item.hint}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A segmented choice that is a real radio group: arrow keys, one tab stop, announced by name. */
export function Segmented<T extends string>({ legend, value, options, onChange, name }: {
  legend: string; value: T; name: string; onChange: (next: T) => void; options: readonly { value: T; label: string }[];
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="text-small font-medium">{legend}</legend>
      <div className="mt-2 inline-flex rounded-lg border border-input bg-sunken p-0.5">
        {options.map((option) => (
          <label key={option.value} className="relative">
            <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="peer sr-only" />
            <span className="flex h-9 min-w-24 cursor-pointer items-center justify-center rounded-md px-4 text-small font-medium text-muted-foreground transition-colors peer-checked:bg-surface-raised peer-checked:text-foreground peer-checked:shadow-card peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring hover:text-foreground">
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
