import type { ComponentProps } from 'react';
import { cn } from '../lib/utils';

const TONES = {
  info: 'border-info/35 bg-info/10 [&_[data-slot=alert-title]]:text-info',
  success: 'border-success/35 bg-success/10 [&_[data-slot=alert-title]]:text-success',
  warning: 'border-warning/40 bg-warning/10 [&_[data-slot=alert-title]]:text-warning',
  danger: 'border-destructive/35 bg-destructive/8 [&_[data-slot=alert-title]]:text-destructive',
} as const;

export type AlertTone = keyof typeof TONES;

/**
 * An inline message about the page or a form. `danger` and `warning` use role="alert" so they are
 * announced when they appear; `info` and `success` use role="status" (polite). Override with `role`.
 */
export function Alert({ tone = 'info', className, role, ...props }: ComponentProps<'div'> & { tone?: AlertTone }) {
  return (
    <div
      role={role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status')}
      className={cn('rounded-xl border px-4 py-3 text-sm text-foreground', TONES[tone], className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="alert-title" className={cn('font-semibold', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-1 leading-relaxed text-muted-foreground', className)} {...props} />;
}
