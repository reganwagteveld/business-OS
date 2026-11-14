import type { ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';

/**
 * Modal dialog: a dimmed, softly blurred overlay and a raised panel. Presentational only; focus
 * management (initial focus, trap, Escape, returning focus) stays with the caller, for example the
 * app's `useDialog`, whose props can be spread onto this component. Rendered into <body> through a
 * portal, because a glass ancestor (backdrop-filter) would otherwise confine a fixed overlay to itself.
 */
export function Dialog({ open, className, children, ...props }: ComponentProps<'div'> & { open: boolean }) {
  if (!open) return null;
  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 backdrop-blur-[2px]">
      <div role="dialog" aria-modal="true" className={cn('w-full max-w-lg rounded-2xl border bg-popover p-6 text-popover-foreground shadow-card', className)} {...props}>
        {children}
      </div>
    </div>
  );
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

export function DialogTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-lg font-semibold tracking-tight', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mt-2 text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-wrap justify-end gap-3', className)} {...props} />;
}
