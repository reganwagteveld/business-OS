import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

const TONES = {
  neutral: 'border-border bg-muted text-muted-foreground',
  brand: 'border-primary/30 bg-primary/12 text-foreground',
  success: 'border-success/35 bg-success/12 text-success',
  warning: 'border-warning/40 bg-warning/12 text-warning',
  danger: 'border-destructive/35 bg-destructive/10 text-destructive',
  info: 'border-info/35 bg-info/12 text-info',
} as const;

export type BadgeTone = keyof typeof TONES;

/** A short label. Tinted, never solid, so a row of badges stays quiet in a dense table. */
export function Badge({ tone = 'neutral', className, ...props }: ComponentProps<'span'> & { tone?: BadgeTone }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)} {...props} />;
}
