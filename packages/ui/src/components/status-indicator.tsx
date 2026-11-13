import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

const TONES = {
  ok: 'bg-emerald-500',
  pending: 'bg-amber-500',
  error: 'bg-destructive',
} as const;

export type StatusTone = keyof typeof TONES;

/** A coloured dot with a text label. The label carries the meaning; colour is never the only signal. */
export function StatusIndicator({ tone, children, className, ...props }: ComponentProps<'span'> & { tone: StatusTone }) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', className)} {...props}>
      <span aria-hidden className={cn('size-2 rounded-full', TONES[tone])} />
      {children}
    </span>
  );
}
