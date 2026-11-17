import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../lib/utils';

/** Up to this many items, progress is one square per item; beyond it, a 4 px bar. */
export const PROGRESS_SQUARES_MAX = 24;

/**
 * Progress as squares (V2-B2 §6.10): one square per item when there are 24 or fewer, otherwise a
 * square-ended 4 px bar. The squares and bar are decorative (`aria-hidden`); the words ("2 of 6 tasks
 * done") always carry the value. Pass `label` to change the words, for example for another noun.
 */
export function ProgressSquares({ done, total, label, className, ...props }: Omit<ComponentProps<'div'>, 'children'> & { done: number; total: number; label?: ReactNode }) {
  const count = Math.max(0, Math.floor(total));
  const filled = Math.min(count, Math.max(0, Math.floor(done)));
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} {...props}>
      {count > 0 && count <= PROGRESS_SQUARES_MAX && (
        <span aria-hidden className="flex flex-wrap gap-0.5" data-testid="progress-squares">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} data-off={i >= filled || undefined} className={cn('pixel-marker', i < filled ? 'text-accent-solid' : 'text-line-strong')} />
          ))}
        </span>
      )}
      {count > PROGRESS_SQUARES_MAX && (
        <span aria-hidden className="pixel-track w-24 shrink-0" data-testid="progress-bar">
          <span className="pixel-track-fill" style={{ width: `${(filled / count) * 100}%` }} />
        </span>
      )}
      <span className="text-small text-fg-muted tabular-nums">{label ?? `${filled} of ${count} tasks done`}</span>
    </div>
  );
}
