import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { actionClass, secondaryClass } from '../shell/frame';
import { useDialog } from './dialog';

/**
 * Unsaved-changes protection for a Zone: editors report by name whether they hold unsaved work;
 * `leave(action)` runs the action straight away when nothing is unsaved, or asks first. Closing the
 * window asks too. The returned `dialog` must be rendered by the Zone.
 */
export function useDraftGuard(): { dirty: boolean; markDraft: (key: string, dirty: boolean) => void; clearDrafts: () => void; leave: (action: () => void) => void; dialog: ReactNode } {
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const dirty = Object.values(drafts).some(Boolean);
  const markDraft = useCallback((key: string, value: boolean) => setDrafts((d) => (Boolean(d[key]) === value ? d : { ...d, [key]: value })), []);
  const clearDrafts = useCallback(() => setDrafts({}), []);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const { ref, onKeyDown } = useDialog(pending !== null, () => setPending(null), { trap: true });

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = useCallback((action: () => void) => (dirty ? setPending(() => action) : action()), [dirty]);
  const dialog = pending ? (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-background/80 px-5 backdrop-blur-sm">
      <div ref={ref} onKeyDown={onKeyDown} role="alertdialog" aria-modal="true" aria-labelledby="discard-title" aria-describedby="discard-body" className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg">
        <h2 id="discard-title" className="text-lg font-semibold tracking-tight">Discard unsaved changes?</h2>
        <p id="discard-body" className="mt-2 text-sm text-muted-foreground">You have changes that have not been saved. If you leave now, they will be lost.</p>
        <div className="mt-6 flex gap-3">
          <button type="button" autoFocus className={actionClass} onClick={() => setPending(null)}>Keep editing</button>
          <button type="button" className={secondaryClass} onClick={() => { const run = pending; setPending(null); run(); }}>Discard changes</button>
        </div>
      </div>
    </div>
  ) : null;
  return { dirty, markDraft, clearDrafts, leave, dialog };
}
