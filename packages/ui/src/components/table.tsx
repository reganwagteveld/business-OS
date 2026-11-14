import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/** Data table on an opaque surface: readable first. Scrolls sideways inside its own frame on narrow windows. */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border bg-card">
      <table className={cn('w-full caption-bottom border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('bg-muted/60 [&_tr]:border-b', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b transition-colors hover:bg-accent/60 aria-selected:bg-accent', className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th scope="col" className={cn('h-10 px-4 text-left align-middle text-xs font-semibold tracking-wide text-muted-foreground uppercase', className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3 align-middle text-card-foreground', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={cn('px-4 py-3 text-left text-xs text-muted-foreground', className)} {...props} />;
}
