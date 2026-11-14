import { cn } from '@business-os/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type MenuEntry =
  | {
      kind: 'item';
      id: string;
      label: ReactNode;
      /** Secondary line under the label. */
      hint?: ReactNode;
      icon?: ReactNode;
      /** Set for choices (theme, active business): rendered as a radio item with aria-checked. */
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: 'heading'; id: string; label: ReactNode }
  | { kind: 'separator'; id: string };

export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'right-start' | 'top-start';

const PLACEMENT: Record<MenuPlacement, string> = {
  'bottom-start': 'left-0 top-full mt-2',
  'bottom-end': 'right-0 top-full mt-2',
  'right-start': 'left-full top-0 ml-2',
  'top-start': 'left-0 bottom-full mb-2',
};

/**
 * A menu button (WAI-ARIA menu pattern). Opens with click, Enter, Space or ArrowDown; arrows,
 * Home and End move between items; Escape closes and returns focus to the button; Tab or a click
 * outside closes. Choosing an item closes the menu and returns focus first, so whatever the item
 * opens next (a confirmation dialog, a new screen) takes focus from a sensible place.
 */
export function Menu({ label, menuLabel, trigger, triggerClassName, entries, placement = 'bottom-start', className }: {
  /** Accessible name of the button. */
  label: string;
  /** Accessible name of the open menu. */
  menuLabel: string;
  trigger: ReactNode;
  triggerClassName?: string;
  entries: readonly MenuEntry[];
  placement?: MenuPlacement;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const focusAt = (index: number) => {
    const list = items();
    if (list.length === 0) return;
    list[(index + list.length) % list.length]!.focus();
  };

  useEffect(() => {
    if (!open) return;
    // Land on the checked choice when there is one, otherwise the first item.
    const list = items();
    (list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
    const outside = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <div ref={wrapper} className={cn('relative', className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        className={triggerClassName}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onMenuKey}
          className={cn('absolute z-40 min-w-60 max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-card', PLACEMENT[placement])}
        >
          {entries.map((entry) => {
            if (entry.kind === 'separator') return <div key={entry.id} role="separator" className="my-1.5 h-px bg-border" />;
            if (entry.kind === 'heading') return <div key={entry.id} role="presentation" className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[.12em] text-muted-foreground uppercase">{entry.label}</div>;
            const radio = entry.checked !== undefined;
            return (
              <button
                key={entry.id}
                type="button"
                role={radio ? 'menuitemradio' : 'menuitem'}
                aria-checked={radio ? entry.checked : undefined}
                tabIndex={-1}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  close(true);
                  entry.onSelect();
                }}
              >
                {entry.icon ? <span className="shrink-0 text-muted-foreground">{entry.icon}</span> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entry.label}</span>
                  {entry.hint ? <span className="block truncate text-xs text-muted-foreground">{entry.hint}</span> : null}
                </span>
                {radio ? <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', entry.checked ? 'bg-primary' : 'bg-transparent')} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
