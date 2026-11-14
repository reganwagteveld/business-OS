import type { ExpenseCategory } from '@business-os/contracts';
import { Badge, Button, Field, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useState, type FormEvent } from 'react';
import type { FinanceClient } from '../../api/finance';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { LoadingRows } from './expense-list';
import { conflictMessage } from './format';

const WRAP = '[overflow-wrap:anywhere]';

/**
 * Expense categories: the defaults every business starts with and its own. Rename, reorder, archive
 * and restore (finance:manage). There is no delete: a category used by recorded expenses must stay,
 * and recorded expenses keep the name they were recorded with.
 */
export function Categories({ client, slug, canManage, tabs, onTab, onChanged, onSessionEnded }: {
  client: FinanceClient; slug: string; canManage: boolean; tabs: readonly ZonePageTab[]; onTab: (id: string) => void;
  onChanged: () => void; onSessionEnded: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { state, reload } = useLoad(`expense-categories|${slug}|${showArchived}`, (signal) => client.categories(slug, showArchived ? 'all' : 'active', signal));
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const rows = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;

  async function change(call: () => Promise<{ kind: string; code?: string; message?: string }>, ok: string) {
    if (busy) return false;
    setBusy(true);
    setMessage(null);
    const out = await call();
    setBusy(false);
    if (out.kind === 'ok') {
      setMessage({ tone: 'ok', text: ok });
      reload();
      onChanged();
      return true;
    }
    if (out.kind === 'unauthenticated') onSessionEnded();
    else if (out.kind === 'conflict') setMessage({ tone: 'error', text: out.code === 'stale' ? 'Someone else changed this category. The list has been reloaded.' : conflictMessage(out.code) });
    else if (out.kind === 'invalid_input') setMessage({ tone: 'error', text: out.message ?? 'Check the name.' });
    else if (out.kind === 'forbidden') setMessage({ tone: 'error', text: 'Only owners and admins can manage categories.' });
    else setMessage({ tone: 'error', text: 'That change could not be saved. Nothing was changed.' });
    if (out.kind === 'conflict') reload();
    return false;
  }

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (await change(() => client.createCategory(slug, { name }), `${name.trim()} was added.`)) setName('');
  };
  const update = (c: ExpenseCategory, patch: Record<string, unknown>, ok: string) => change(() => client.updateCategory(slug, c.id, { version: c.version, ...patch }), ok);
  const move = (list: ExpenseCategory[], i: number, by: -1 | 1) => {
    const other = list[i + by];
    const c = list[i]!;
    if (!other) return;
    // Swap into the neighbour's slot; equal positions fall back to name order, so step past it.
    const target = by < 0 ? Math.max(0, other.position - 1) : other.position + 1;
    void update(c, { position: target }, `${c.name} moved ${by < 0 ? 'up' : 'down'}.`);
  };

  return (
    <ZonePage
      title="Expense categories" eyebrow="Finance" tabs={tabs} currentTab="categories" onTab={onTab}
      description="Group expenses for reporting. Categories are archived, never deleted, so past expenses keep theirs."
      secondaryActions={<Button variant="outline" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide archived' : 'Show archived'}</Button>}
    >
      {message ? <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm font-medium text-destructive' : 'text-sm'}>{message.text}</p> : null}
      {canManage ? (
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <Field label="New category" className="min-w-60 flex-1">{(c) => <Input {...c} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Button type="submit" loading={busy} disabled={name.trim() === ''}>Add category</Button>
        </form>
      ) : <p className="text-sm text-muted-foreground">Only owners and admins can change categories.</p>}
      {state.status === 'loading' ? <LoadingRows label="Loading categories…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Expense categories" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {rows ? (
        <Table aria-label="Expense categories">
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead>{canManage ? <TableHead className="text-right">Actions</TableHead> : null}</TableRow></TableHeader>
          <TableBody>
            {rows.map((c, i) => (
              <TableRow key={c.id}>
                <TableCell className={WRAP}>
                  {editing?.id === c.id ? (
                    <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (await update(c, { name: editing.name }, 'Category renamed.')) setEditing(null); }}>
                      <Input aria-label={`New name for ${c.name}`} maxLength={100} value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} className="max-w-xs" autoFocus />
                      <Button type="submit" size="sm" loading={busy}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </form>
                  ) : <span className={c.archivedAt ? 'text-muted-foreground' : undefined}>{c.name}</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <Badge>{c.systemKey ? 'Default' : 'Custom'}</Badge>
                    {c.archivedAt ? <Badge tone="warning">Archived</Badge> : null}
                  </div>
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {!c.archivedAt ? (
                        <>
                          <Button size="sm" variant="ghost" aria-label={`Move ${c.name} up`} disabled={busy || i === 0} onClick={() => move(rows.filter((r) => !r.archivedAt), rows.filter((r) => !r.archivedAt).indexOf(c), -1)}>↑</Button>
                          <Button size="sm" variant="ghost" aria-label={`Move ${c.name} down`} disabled={busy} onClick={() => move(rows.filter((r) => !r.archivedAt), rows.filter((r) => !r.archivedAt).indexOf(c), 1)}>↓</Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing({ id: c.id, name: c.name })}>Rename</Button>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(c, { archived: true }, `${c.name} archived.`)}>Archive</Button>
                        </>
                      ) : (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => void update(c, { archived: false }, `${c.name} restored.`)}>Restore</Button>
                      )}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </ZonePage>
  );
}
