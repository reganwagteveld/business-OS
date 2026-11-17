import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input } from '@business-os/ui';
import { useState, type ReactNode } from 'react';

/**
 * A confirmation for one action. With `phrase`, the person must type it exactly first (intent
 * confirmation for the dangerous actions: ownership, leaving, removal). Typing is not authentication.
 * The dialog stays open while the request runs and shows the failure inside it, so the result of the
 * action is never out of sight.
 */
export function ConfirmDialog({ open, title, description, phrase, confirmLabel, destructive, busy, error, onConfirm, onCancel, children }: {
  open: boolean; title: string; description: ReactNode; phrase?: string; confirmLabel: string; destructive?: boolean; busy: boolean; error?: string | null;
  onConfirm: () => void; onCancel: () => void; children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent>
        {open ? <Body {...{ title, description, phrase, confirmLabel, destructive, busy, error, onConfirm, onCancel }}>{children}</Body> : null}
      </DialogContent>
    </Dialog>
  );
}

function Body({ title, description, phrase, confirmLabel, destructive, busy, error, onConfirm, onCancel, children }: Omit<Parameters<typeof ConfirmDialog>[0], 'open'>) {
  const [typed, setTyped] = useState('');
  const ready = phrase === undefined || typed.trim() === phrase;
  return (
    <form onSubmit={(event) => { event.preventDefault(); if (ready && !busy) onConfirm(); }}>
      <DialogTitle>{title}</DialogTitle>
      <DialogDescription asChild><div>{description}</div></DialogDescription>
      {children}
      {phrase !== undefined ? (
        <Field label={<>Type <strong>{phrase}</strong> to confirm</>} className="mt-4">{(c) => <Input {...c} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
      ) : null}
      {error ? <Alert tone="danger" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant={destructive ? 'destructive' : 'primary'} loading={busy} disabled={!ready}>{confirmLabel}</Button>
      </DialogFooter>
    </form>
  );
}
