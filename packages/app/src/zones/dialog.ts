import { useEffect, useRef, type KeyboardEvent } from 'react';

// Remembers the element focused before the current one, so a dialog that moves focus into itself on
// open (autoFocus) can still hand focus back to whatever opened it.
let current: Element | null = null;
let previous: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (event) => {
    previous = current;
    current = event.target as Element;
  }, true);
}

/**
 * Focus handling shared by the Zone's confirmation dialogs:
 * - when the dialog closes, focus returns to whatever opened it (if it is still on the page);
 * - Escape chooses the safe option (`onEscape`);
 * - with `trap`, Tab and Shift+Tab stay inside the dialog (for modal dialogs).
 * Returns the props to spread on the dialog element.
 */
export function useDialog(open: boolean, onEscape: () => void, opts: { trap?: boolean } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    opener.current = ref.current && active && ref.current.contains(active) ? previous : active;
    return () => {
      const target = opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onEscape();
      return;
    }
    if (!opts.trap || event.key !== 'Tab' || !ref.current) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return { ref, onKeyDown };
}
