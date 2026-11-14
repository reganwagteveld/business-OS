import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

/** Spinning ring. With a `label` it announces itself as a status; without one it is decorative. Slows for reduced motion. */
export function Spinner({ label, className, ...props }: ComponentProps<'span'> & { label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className={cn('inline-flex items-center gap-2 text-sm text-muted-foreground', className)} {...props}>
      <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent text-primary motion-reduce:animate-[spin_2s_linear_infinite]" />
      {label}
    </span>
  );
}

/** Placeholder block for content that is loading. Static for reduced motion. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)} {...props} />;
}
