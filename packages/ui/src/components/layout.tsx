import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';

/** A dividing line. Decorative by default; pass `decorative={false}` when it separates meaningful groups. */
export function Separator({ orientation = 'horizontal', decorative = true, className, ...props }: ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical'; decorative?: boolean }) {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      className={cn('shrink-0 bg-border', orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px', className)}
      {...props}
    />
  );
}

/** The top of a page: optional eyebrow, the page's h1, a description and actions on the right. */
export function PageHeader({ title, description, eyebrow, actions, className, ...props }: Omit<ComponentProps<'header'>, 'title'> & { title: ReactNode; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-4', className)} {...props}>
      <div className="min-w-0">
        {eyebrow && <p className="text-xs font-semibold tracking-[.14em] text-muted-foreground uppercase">{eyebrow}</p>}
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </header>
  );
}

/** Heading for a section within a page (h2 by default), with an optional description and actions. */
export function SectionHeader({ title, description, actions, as: Heading = 'h2', className, ...props }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; description?: ReactNode; actions?: ReactNode; as?: 'h2' | 'h3' }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-3', className)} {...props}>
      <div className="min-w-0">
        <Heading className="text-lg font-semibold tracking-tight">{title}</Heading>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Shown where a list or table has nothing in it yet: what is missing and what to do next. */
export function EmptyState({ title, description, icon, action, className, ...props }: Omit<ComponentProps<'div'>, 'title'> & { title: ReactNode; description?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className={cn('flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-12 text-center', className)} {...props}>
      {icon && <div aria-hidden className="mb-4 flex size-12 items-center justify-center rounded-full bg-accent text-foreground">{icon}</div>}
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * A group of related form fields: a fieldset whose legend is the group's heading, so screen readers
 * announce it with each field. Lay the fields out with `className` (for example a grid).
 */
export function FormSection({ title, description, className, children, ...props }: Omit<ComponentProps<'fieldset'>, 'title'> & { title: ReactNode; description?: ReactNode }) {
  return (
    <fieldset className={cn('min-w-0 border-0 p-0', className)} {...props}>
      <legend className="text-sm font-semibold">{title}</legend>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-4 grid gap-4">{children}</div>
    </fieldset>
  );
}
