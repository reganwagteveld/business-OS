import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';

const MARKER = {
  success: 'text-status-success-solid',
  warning: 'text-status-warning-solid',
  danger: 'text-status-danger-solid',
  info: 'text-status-info-solid',
  neutral: 'text-fg-subtle',
} as const;

export type MarkerTone = keyof typeof MARKER;

/**
 * The square marker on its own (V2-B2 §6.10): decorative, so always `aria-hidden`. Use it inside
 * `PixelMarker`, figure labels and chart legends, always next to words that say the same thing.
 */
export function Marker({ tone = 'neutral', hollow = false, className }: { tone?: MarkerTone; hollow?: boolean; className?: string }) {
  return <span aria-hidden data-hollow={hollow || undefined} className={cn('pixel-marker', MARKER[tone], className)} />;
}

/**
 * A status: a 6 px square followed by the status word (V2-B2 §6.10, D-V2B2-7). Filled means "in a
 * state" (Active, Paid, Overdue); `hollow` means "not started" (Draft, Planned, To do). The word always
 * carries the meaning, so colour is never the only signal; danger also colours its word. No pill form.
 */
export function PixelMarker({ tone = 'neutral', hollow = false, children, className, ...props }: ComponentProps<'span'> & { tone?: MarkerTone; hollow?: boolean; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-small whitespace-nowrap', tone === 'danger' && 'font-medium text-status-danger-fg', className)} {...props}>
      <Marker tone={tone} hollow={hollow} />
      {children}
    </span>
  );
}
