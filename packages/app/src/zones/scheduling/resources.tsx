import type { SchedulingEvent, SchedulingResource, SchedulingResourceType } from '@business-os/contracts';
import {
  Alert, AlertDescription, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle, Field, Input, Select, Skeleton, Textarea,
} from '@business-os/ui';
import { useState, type FormEvent } from 'react';
import type { ResourceListQuery, ResourceWithBookings, SchedulingClient } from '../../api/scheduling';
import type { Outcome } from '../../api/tenancy';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { formatDateTime } from './calendar-math';
import { STATUS_LABEL, STATUS_TONE, themeAccent, TYPE_LABEL, TYPES } from './resource-labels';

type StatusFilter = NonNullable<ResourceListQuery['status']>;
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'current', label: 'Active and inactive' }, { id: 'active', label: 'Active' }, { id: 'inactive', label: 'Inactive' }, { id: 'archived', label: 'Archived' }, { id: 'all', label: 'All' },
];

const failure = (o: Outcome<unknown>, action: string) =>
  o.kind === 'forbidden' ? 'Your role does not allow managing resources.'
    : o.kind === 'conflict' && o.code === 'stale' ? 'Someone else changed this resource. Close it and open it again.'
    : o.kind === 'conflict' && o.code === 'archived' ? 'This resource is archived. Restore it first.'
    : o.kind === 'unreachable' ? `Can't reach Business OS. Nothing was ${action}.` : `Something went wrong. Nothing was ${action}.`;

/**
 * The resource directory (S2): search by name, filter by type and status, server-side pages of 50 by
 * name. Managing (create, edit, deactivate, archive, restore) needs scheduling:manage_resources; the
 * buttons follow that key for presentation only, and the API checks it again.
 */
export function ResourceDirectory({ client, slug, locale, timeZone, canManage, onSessionEnded }: {
  client: SchedulingClient; slug: string; locale: string; timeZone: string; canManage: boolean; onSessionEnded: () => void;
}) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<SchedulingResourceType | ''>('');
  const [status, setStatus] = useState<StatusFilter>('current');
  const [pages, setPages] = useState<string[]>([]); // cursors of the pages after the first
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState<{ kind: 'none' } | { kind: 'detail'; id: string } | { kind: 'new' }>({ kind: 'none' });
  const [notice, setNotice] = useState<string | null>(null);
  const query = { q: q || undefined, type: type || undefined, status };
  const first = useLoad(`scheduling-resources|${slug}|${JSON.stringify(query)}|${tick}`, (signal) => client.resources(slug, query, signal));
  const firstPage = first.state.status === 'done' && first.state.outcome.kind === 'ok' ? first.state.outcome.data : null;
  const changed = (message: string) => {
    setOpen({ kind: 'none' });
    setNotice(message);
    setPages([]);
    setTick((t) => t + 1);
  };

  return (
    <div className="space-y-4">
      {notice ? <Alert tone="success" role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Search</span>
          <Input type="search" value={q} maxLength={100} placeholder="Name" onChange={(e) => { setQ(e.target.value); setPages([]); }} className="w-56" /></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Type</span>
          <Select className="w-auto" value={type} onChange={(e) => { setType(e.target.value as SchedulingResourceType | ''); setPages([]); }}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </Select></label>
        <label className="flex flex-col gap-1 text-sm"><span className="font-medium">Status</span>
          <Select className="w-auto" value={status} onChange={(e) => { setStatus(e.target.value as StatusFilter); setPages([]); }}>
            {STATUS_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select></label>
        {canManage ? <Button className="ml-auto" onClick={() => setOpen({ kind: 'new' })}>New resource</Button> : null}
      </div>
      {first.state.status === 'done' && first.state.outcome.kind !== 'ok' ? (
        <Problem outcome={first.state.outcome} what="Resources" onRetry={first.reload} onSessionEnded={onSessionEnded} />
      ) : firstPage === null ? (
        <div role="status" aria-busy="true" className="space-y-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><span className="sr-only">Loading resources…</span></div>
      ) : firstPage.resources.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {q || type || status !== 'current' ? 'No resources match these filters.' : canManage ? 'No resources yet. Add the people, rooms and equipment you book.' : 'No resources yet. Ask a manager to add them.'}
        </div>
      ) : (
        <ul aria-label="Resources" className="divide-y overflow-hidden rounded-2xl border bg-card">
          <ResourceRows resources={firstPage.resources} onOpen={(id) => setOpen({ kind: 'detail', id })} />
          {pages.map((cursor) => <MorePage key={cursor} client={client} slug={slug} query={{ ...query, cursor }} onOpen={(id) => setOpen({ kind: 'detail', id })} onSessionEnded={onSessionEnded}
            onNext={(next) => setPages((p) => (next && !p.includes(next) ? [...p, next] : p))} last={cursor === pages[pages.length - 1]} />)}
          {pages.length === 0 && firstPage.nextCursor ? (
            <li className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => setPages([firstPage.nextCursor!])}>Show more</Button></li>
          ) : null}
        </ul>
      )}
      {open.kind === 'new' ? (
        <ResourceForm client={client} slug={slug} onClose={() => setOpen({ kind: 'none' })} onSessionEnded={onSessionEnded}
          onSaved={(r) => changed(`Resource “${r.resource.name}” added.`)} />
      ) : null}
      {open.kind === 'detail' ? (
        <ResourceDetail client={client} slug={slug} id={open.id} locale={locale} timeZone={timeZone} canManage={canManage}
          onChanged={changed} onClose={() => setOpen({ kind: 'none' })} onSessionEnded={onSessionEnded} />
      ) : null}
    </div>
  );
}

function ResourceRows({ resources, onOpen }: { resources: SchedulingResource[]; onOpen: (id: string) => void }) {
  return resources.map((r) => (
    <li key={r.id}>
      <button type="button" onClick={() => onOpen(r.id)}
        className="flex min-h-12 w-full flex-wrap items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden className="size-3 rounded-full border" style={{ background: r.colour ?? 'transparent' }} />
        <span className="font-medium">{r.name}</span>
        <span className="text-muted-foreground">{TYPE_LABEL[r.type]}</span>
        <Badge tone={STATUS_TONE[r.status]} className="ml-auto">{STATUS_LABEL[r.status]}</Badge>
      </button>
    </li>
  ));
}

function MorePage({ client, slug, query, onOpen, onNext, last, onSessionEnded }: {
  client: SchedulingClient; slug: string; query: ResourceListQuery; onOpen: (id: string) => void; onNext: (cursor: string | null) => void; last: boolean; onSessionEnded: () => void;
}) {
  const page = useLoad(`scheduling-resources-page|${slug}|${JSON.stringify(query)}`, (signal) => client.resources(slug, query, signal));
  if (page.state.status === 'loading') return <li role="status" className="p-2 text-center text-xs text-muted-foreground">Loading…</li>;
  if (page.state.outcome.kind !== 'ok') return <li className="p-2"><Problem outcome={page.state.outcome} what="More resources" onRetry={page.reload} onSessionEnded={onSessionEnded} /></li>;
  const data = page.state.outcome.data;
  return (
    <>
      <ResourceRows resources={data.resources} onOpen={onOpen} />
      {last && data.nextCursor ? <li className="p-2 text-center"><Button variant="ghost" size="sm" onClick={() => onNext(data.nextCursor)}>Show more</Button></li> : null}
    </>
  );
}

/** Creates a resource, or edits one's details (name, type, description, colour). */
function ResourceForm({ client, slug, resource, onSaved, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; resource?: SchedulingResource; onSaved: (r: ResourceWithBookings) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const [name, setName] = useState(resource?.name ?? '');
  const [type, setType] = useState<SchedulingResourceType>(resource?.type ?? 'ROOM');
  const [description, setDescription] = useState(resource?.description ?? '');
  const [colour, setColour] = useState(() => resource?.colour ?? themeAccent());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = resource
      ? await client.updateResource(slug, resource.id, {
        version: resource.version,
        ...(name !== resource.name ? { name } : {}), ...(type !== resource.type ? { type } : {}),
        ...((description || null) !== resource.description ? { description } : {}), ...((colour || null) !== resource.colour ? { colour: colour || null } : {}),
      })
      : await client.createResource(slug, { name, type, description, ...(colour ? { colour } : {}) });
    setBusy(false);
    if (outcome.kind === 'ok') return onSaved(outcome.data);
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'invalid_input') {
      setFields(outcome.fields ?? {});
      setError(outcome.message === 'Nothing to update' ? 'Nothing changed.' : outcome.message);
      return;
    }
    setError(failure(outcome, 'saved'));
  };
  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent>
        <DialogTitle>{resource ? 'Edit resource' : 'New resource'}</DialogTitle>
        <DialogDescription>A person, room, piece of equipment or anything else your events need. Named in your own words.</DialogDescription>
        <form onSubmit={(e) => void submit(e)} className="mt-4 space-y-4" noValidate>
          <Field label="Name" error={fields.name}>{(p) => <Input {...p} value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Type" error={fields.type}>
            {(p) => <Select {...p} value={type} onChange={(e) => setType(e.target.value as SchedulingResourceType)}>{TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</Select>}
          </Field>
          <Field label="Description" error={fields.description}>{(p) => <Textarea {...p} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="Colour" error={fields.colour}>{(p) => <Input {...p} type="color" className="h-10 w-20 p-1" value={colour} onChange={(e) => setColour(e.target.value)} />}</Field>
          {type === 'PERSON' ? <p className="text-xs text-muted-foreground">A person resource is not linked to an employee record, and holds no personal details.</p> : null}
          {error ? <Alert tone="danger" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>Close</Button>
            <Button type="submit" loading={busy}>{resource ? 'Save changes' : 'Add resource'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const UPCOMING_DAYS = 31;

/** One resource: details, status actions, and its bookings over the next 31 days. */
function ResourceDetail({ client, slug, id, locale, timeZone, canManage, onChanged, onClose, onSessionEnded }: {
  client: SchedulingClient; slug: string; id: string; locale: string; timeZone: string; canManage: boolean;
  onChanged: (message: string) => void; onClose: () => void; onSessionEnded: () => void;
}) {
  const loaded = useLoad(`scheduling-resource|${slug}|${id}`, (signal) => client.resource(slug, id, signal));
  const [from] = useState(() => new Date().toISOString());
  const to = new Date(Date.parse(from) + UPCOMING_DAYS * 86_400_000).toISOString();
  const bookings = useLoad(`scheduling-resource-bookings|${slug}|${id}|${from}`, (signal) => client.events(slug, { resourceId: id, from, to, status: 'scheduled' }, signal));
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<'archive' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = loaded.state.status === 'done' && loaded.state.outcome.kind === 'ok' ? loaded.state.outcome.data : null;
  const r = data?.resource;

  async function act(kind: 'activate' | 'deactivate' | 'archive' | 'restore') {
    if (!r) return;
    setBusy(true);
    setError(null);
    const outcome = kind === 'archive' ? await client.archiveResource(slug, r.id, r.version)
      : kind === 'restore' ? await client.restoreResource(slug, r.id, r.version)
      : await client.updateResource(slug, r.id, { version: r.version, status: kind === 'activate' ? 'ACTIVE' : 'INACTIVE' });
    setBusy(false);
    if (outcome.kind === 'ok') {
      const left = outcome.data.upcomingBookings;
      const keep = left > 0 ? ` ${left} upcoming booking${left === 1 ? '' : 's'} still use it; move them if needed.` : '';
      return onChanged(kind === 'archive' ? `“${r.name}” archived.${keep}` : kind === 'restore' ? `“${r.name}” restored and bookable again.`
        : kind === 'activate' ? `“${r.name}” is active and bookable.` : `“${r.name}” is inactive and cannot be newly booked.${keep}`);
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setError(failure(outcome, 'changed'));
  }

  if (editing && r) {
    return <ResourceForm client={client} slug={slug} resource={r} onClose={() => setEditing(false)} onSessionEnded={onSessionEnded} onSaved={() => onChanged('Changes saved.')} />;
  }
  const events: SchedulingEvent[] | null = bookings.state.status === 'done' && bookings.state.outcome.kind === 'ok' ? bookings.state.outcome.data : null;
  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        {loaded.state.status === 'loading' ? (
          <><DialogTitle className="sr-only">Loading resource</DialogTitle><div role="status" aria-busy="true"><Skeleton className="h-6 w-2/3" /></div></>
        ) : !r ? (
          <><DialogTitle className="sr-only">Resource</DialogTitle>
            <Problem outcome={loaded.state.status === 'done' ? loaded.state.outcome : { kind: 'invalid' }} what="This resource" onRetry={loaded.reload} onSessionEnded={onSessionEnded} /></>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{r.name}</DialogTitle>
              <Badge tone="neutral">{TYPE_LABEL[r.type]}</Badge>
              <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
            </div>
            <DialogDescription>{r.description ?? 'No description.'}</DialogDescription>
            <p className="mt-2 text-sm text-muted-foreground">
              {r.status === 'ACTIVE' ? 'Can be booked.' : r.status === 'INACTIVE' ? 'Inactive: existing bookings keep it, but it cannot be newly booked.' : 'Archived: kept in history, read-only, and cannot be booked.'}
            </p>
            <section className="mt-4">
              <h3 className="text-sm font-semibold">Upcoming bookings (next {UPCOMING_DAYS} days)</h3>
              {bookings.state.status === 'done' && bookings.state.outcome.kind !== 'ok' ? (
                <Problem outcome={bookings.state.outcome} what="Bookings" onRetry={bookings.reload} onSessionEnded={onSessionEnded} />
              ) : events === null ? (
                <p role="status" className="text-sm text-muted-foreground">Loading bookings…</p>
              ) : events.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing booked.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {events.map((e) => <li key={e.id}>{formatDateTime(e.startAt, locale, timeZone)}: {e.title}{!e.blocksAvailability ? ' (does not block time)' : ''}</li>)}
                </ul>
              )}
            </section>
            {confirming ? (
              <Alert tone="warning" role="alert" className="mt-4"><AlertDescription>
                Archive {r.name}? It stays on {data.upcomingBookings} upcoming booking{data.upcomingBookings === 1 ? '' : 's'} and in the history, but cannot be booked again until restored.
              </AlertDescription></Alert>
            ) : null}
            {error ? <Alert tone="danger" role="alert" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter>
              {confirming ? (
                <>
                  <Button variant="outline" onClick={() => setConfirming(null)} disabled={busy}>Keep it</Button>
                  <Button variant="destructive" loading={busy} onClick={() => void act('archive')}>Archive resource</Button>
                </>
              ) : (
                <>
                  <Button variant="outline" onClick={onClose}>Close</Button>
                  {canManage && r.status === 'ARCHIVED' ? <Button loading={busy} onClick={() => void act('restore')}>Restore</Button> : null}
                  {canManage && r.status !== 'ARCHIVED' ? <Button variant="ghost" onClick={() => setConfirming('archive')}>Archive</Button> : null}
                  {canManage && r.status === 'ACTIVE' ? <Button variant="secondary" loading={busy} onClick={() => void act('deactivate')}>Set inactive</Button> : null}
                  {canManage && r.status === 'INACTIVE' ? <Button variant="secondary" loading={busy} onClick={() => void act('activate')}>Set active</Button> : null}
                  {canManage && r.status !== 'ARCHIVED' ? <Button onClick={() => setEditing(true)}>Edit</Button> : null}
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
