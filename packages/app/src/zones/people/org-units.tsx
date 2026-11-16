import type { Department, Location } from '@business-os/contracts';
import { Alert, AlertTitle, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, EmptyState, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@business-os/ui';
import { useRef, useState } from 'react';
import type { OrgUnitFilter, PeopleClient } from '../../api/people';
import type { Outcome } from '../../api/tenancy';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';

export type OrgKind = 'department' | 'location';
type Unit = Department | Location;
const WORDS = {
  department: { one: 'department', many: 'Departments', detail: 'Description', description: 'The teams your employees belong to.' },
  location: { one: 'location', many: 'Locations', detail: 'Address', description: 'The places your employees work.' },
} as const;
const detailOf = (u: Unit) => ('description' in u ? u.description : u.address);

/** Server reasons for a refused change, in words a person can act on. */
function reasonFor(kind: OrgKind, outcome: Outcome<unknown>, verb: string): string {
  const w = WORDS[kind].one;
  switch (outcome.kind) {
    case 'conflict':
      switch (outcome.code) {
        case 'duplicate_name': return `An active ${w} with this name already exists.`;
        case 'in_use': return kind === 'department' ? 'People are still assigned to this department. Move them to another department first.' : 'People still work at this location. Move them to another location first.';
        case 'stale': return `Someone else changed this ${w}. Close this and reopen it to see the latest.`;
        case 'archived': return `This ${w} is archived. Restore it before editing.`;
        case 'not_archived': return `This ${w} is already active.`;
        default: return `That change conflicts with the current ${w}. Reload and try again.`;
      }
    case 'forbidden': return `Your role does not allow you to ${verb} ${w}s. Nothing was changed.`;
    case 'not_found': return `This ${w} no longer exists in this business.`;
    case 'invalid_input': return outcome.message;
    case 'unreachable': return 'Could not reach Business OS. Nothing was changed. Try again.';
    default: return 'Something went wrong. Nothing was changed.';
  }
}

/**
 * Departments or locations: viewed by anyone with people:read, created, edited, archived and restored
 * with people:configure (presentation only; the API checks the key on every request). Units are archived,
 * never deleted, and the server refuses to archive one that people are still assigned to.
 */
export function OrgUnits({ kind, client, slug, canConfigure, tabs, tab, onTab, onChanged, onSessionEnded }: {
  kind: OrgKind; client: PeopleClient; slug: string; canConfigure: boolean; tabs: readonly ZonePageTab[]; tab: string; onTab: (id: string) => void;
  /** Called after a change so the Zone reloads the choices its filters and forms offer. */
  onChanged: () => void; onSessionEnded: () => void;
}) {
  const w = WORDS[kind];
  const [show, setShow] = useState<OrgUnitFilter>('active');
  const [editor, setEditor] = useState<{ unit?: Unit } | null>(null);
  const [archiving, setArchiving] = useState<Unit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const { state, reload } = useLoad<Unit[]>(`org-${kind}|${slug}|${show}`, (signal) =>
    (kind === 'department' ? client.departments(slug, signal, show) : client.locations(slug, signal, show)) as Promise<Outcome<Unit[]>>);
  const done = (message: string) => { setNotice(message); setRowError(null); reload(); onChanged(); };
  const units = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;

  const restore = async (u: Unit) => {
    const outcome = kind === 'department' ? await client.restoreDepartment(slug, u.id) : await client.restoreLocation(slug, u.id);
    if (outcome.kind === 'ok') return done(`${u.name} was restored.`);
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setRowError(reasonFor(kind, outcome, 'restore'));
  };
  const add = canConfigure ? <Button onClick={() => setEditor({})}>Add {w.one}</Button> : undefined;

  return (
    <ZonePage title={w.many} eyebrow="People" description={w.description} primaryActions={add} tabs={tabs} currentTab={tab} onTab={onTab}>
      {notice ? <p role="status" className="rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}
      {rowError ? <Alert tone="danger"><AlertTitle>{rowError}</AlertTitle></Alert> : null}
      <div className="max-w-xs">
        <Field label="Show">{(c) => (
          <Select {...c} value={show} onChange={(e) => setShow(e.target.value as OrgUnitFilter)}>
            <option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option>
          </Select>
        )}</Field>
      </div>
      {state.status === 'loading' ? <div role="status" aria-busy="true" className="h-24 animate-pulse rounded-xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading {w.many.toLowerCase()}…</span></div> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what={w.many} onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {units && units.length === 0 ? (
        <EmptyState title={show === 'archived' ? `No archived ${w.many.toLowerCase()}` : `No ${w.many.toLowerCase()} yet`}
          description={canConfigure ? `Add a ${w.one} so you can assign employees to it.` : `${w.many} added by your administrators will appear here.`} action={show === 'archived' ? undefined : add} />
      ) : null}
      {units && units.length > 0 ? (
        <Table aria-label={w.many}>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead className="hidden sm:table-cell">{w.detail}</TableHead><TableHead>Status</TableHead>
              {canConfigure ? <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {units.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium [overflow-wrap:anywhere]">{u.name}</TableCell>
                <TableCell className="hidden sm:table-cell [overflow-wrap:anywhere]">{detailOf(u) ?? '—'}</TableCell>
                <TableCell><Badge tone={u.archivedAt ? 'neutral' : 'success'}>{u.archivedAt ? 'Archived' : 'Active'}</Badge></TableCell>
                {canConfigure ? (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {u.archivedAt ? <Button size="sm" variant="outline" onClick={() => void restore(u)} aria-label={`Restore ${u.name}`}>Restore</Button> : (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setEditor({ unit: u })} aria-label={`Edit ${u.name}`}>Edit</Button>
                          <Button size="sm" variant="outline" onClick={() => setArchiving(u)} aria-label={`Archive ${u.name}`}>Archive</Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      {editor ? <UnitEditor kind={kind} client={client} slug={slug} unit={editor.unit} onClose={() => setEditor(null)} onSessionEnded={onSessionEnded}
        onSaved={(u, created) => { setEditor(null); done(created ? `${u.name} was added.` : 'Changes saved.'); }} /> : null}
      {archiving ? <ArchiveDialog kind={kind} client={client} slug={slug} unit={archiving} onClose={() => setArchiving(null)} onSessionEnded={onSessionEnded}
        onArchived={(u) => { setArchiving(null); done(`${u.name} was archived.`); }} /> : null}
    </ZonePage>
  );
}

function UnitEditor({ kind, client, slug, unit, onClose, onSaved, onSessionEnded }: {
  kind: OrgKind; client: PeopleClient; slug: string; unit?: Unit; onClose: () => void; onSaved: (u: Unit, created: boolean) => void; onSessionEnded: () => void;
}) {
  const w = WORDS[kind];
  const [name, setName] = useState(unit?.name ?? '');
  const [detail, setDetail] = useState((unit && detailOf(unit)) ?? '');
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const field = kind === 'department' ? 'description' : 'address';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (!name.trim()) return setNameError('A name is required');
    setNameError(null);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim(), [field]: detail.trim() === '' ? null : detail.trim() };
      let outcome: Outcome<Unit>;
      if (unit) {
        const patch: Record<string, unknown> = { version: unit.version };
        if (name.trim() !== unit.name) patch.name = body.name;
        if (body[field] !== (detailOf(unit) ?? null)) patch[field] = body[field];
        if (Object.keys(patch).length === 1) return onClose();
        outcome = await (kind === 'department' ? client.updateDepartment(slug, unit.id, patch) : client.updateLocation(slug, unit.id, patch));
      } else {
        outcome = await (kind === 'department' ? client.createDepartment(slug, body) : client.createLocation(slug, body));
      }
      if (outcome.kind === 'ok') return onSaved(outcome.data, !unit);
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      const message = reasonFor(kind, outcome, unit ? 'edit' : 'add');
      if (outcome.kind === 'conflict' && outcome.code === 'duplicate_name') setNameError(message);
      else setError(message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
          <DialogTitle>{unit ? `Edit ${w.one}` : `Add ${w.one}`}</DialogTitle>
          <DialogDescription>{w.description}</DialogDescription>
          {error ? <Alert tone="danger"><AlertTitle>{error}</AlertTitle></Alert> : null}
          <Field label="Name" error={nameError}>{(c) => <Input {...c} maxLength={120} value={name} onChange={(e) => { setName(e.target.value); setNameError(null); }} />}</Field>
          <Field label={w.detail}>{(c) => <Textarea {...c} maxLength={kind === 'department' ? 2000 : 500} value={detail} onChange={(e) => setDetail(e.target.value)} />}</Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy}>{unit ? 'Save changes' : `Add ${w.one}`}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({ kind, client, slug, unit, onClose, onArchived, onSessionEnded }: {
  kind: OrgKind; client: PeopleClient; slug: string; unit: Unit; onClose: () => void; onArchived: (u: Unit) => void; onSessionEnded: () => void;
}) {
  const w = WORDS[kind];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const confirm = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await (kind === 'department' ? client.archiveDepartment(slug, unit.id) : client.archiveLocation(slug, unit.id));
      if (outcome.kind === 'ok') return onArchived(outcome.data);
      if (outcome.kind === 'unauthenticated') return onSessionEnded();
      setError(reasonFor(kind, outcome, 'archive'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogTitle>Archive {unit.name}?</DialogTitle>
        <DialogDescription>
          Archived {w.many.toLowerCase()} can no longer be chosen for employees, but nothing is deleted and you can restore it any time. It cannot be archived while people are assigned to it.
        </DialogDescription>
        {error ? <Alert tone="danger" className="mt-4"><AlertTitle>{error}</AlertTitle></Alert> : null}
        <DialogFooter className="mt-6">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" loading={busy} onClick={() => void confirm()}>Archive {w.one}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
