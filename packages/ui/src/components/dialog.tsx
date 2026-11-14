import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useRef, type ComponentProps } from 'react';
import { cn } from '../lib/utils';

/**
 * Modal dialog built on Radix UI's Dialog primitive, which provides the accessibility behaviour:
 * - initial focus moves into the dialog (first focusable element, or the one marked `autoFocus`);
 * - Tab and Shift+Tab stay inside while it is open, and the rest of the page is hidden from assistive tech;
 * - Escape and clicking the overlay close it (via `onOpenChange`);
 * - focus returns to whatever was focused before it opened (usually the trigger), falling back to the trigger;
 * - `DialogTitle` and `DialogDescription` are wired to `aria-labelledby` and `aria-describedby`.
 * Every dialog needs a `DialogTitle` (wrap it in a visually hidden element if it should not show).
 * Content is portalled to <body>, so a glass ancestor (backdrop-filter) cannot confine the overlay.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  // Radix returns focus to the Trigger only. A dialog opened from elsewhere (a row action, a shortcut)
  // has no Trigger, so remember what had focus just before focus moved in, and return it there.
  const opener = useRef<Element | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
          'rounded-2xl border bg-popover p-6 text-popover-foreground shadow-card outline-none',
          className,
        )}
        onOpenAutoFocus={(event) => {
          opener.current = document.activeElement;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const target = opener.current;
          if (event.defaultPrevented || !(target instanceof HTMLElement) || target === document.body || !target.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold tracking-tight', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('mt-2 text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-wrap justify-end gap-3', className)} {...props} />;
}
