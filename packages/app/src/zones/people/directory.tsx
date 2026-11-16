import type { Department, Location } from '@business-os/contracts';
import { Badge, Button, EmptyState, Field, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useEffect, useState } from 'react';
import type { EmployeeQuery, PeopleClient } from '../../api/people';
import { ZonePage, type ZonePageTab } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { formatDate, STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from './format';

export interface DirectoryFilters {
  q: string; status: EmployeeQuery['status']; departmentId: string; locationId: string; sort: NonNullable<EmployeeQuery['sort']>;
}
export const DEFAULT_FILTERS: DirectoryFilters = { q: '', status: 'current', departmentId: '', locationId: '', sort: 'name' };
export const PAGE_SIZE = 25;
const WRAP = '[overflow-wrap:anywhere]';

/**
 * The employee directory. Searched, filtered, sorted and paged on the server (keyset cursors), 25 at a
 * time, so it stays usable with thousands of employees. Only work information is listed: personal
 * details are a separate resource the list never asks for.
 */
export function Directory({ client, slug, locale, departments, locations, filters, onFilters, canManage, tabs, onTab, onOpen, onAdd, onSessionEnded }: {
  client: PeopleClient; slug: string; locale?: string; departments: Department[] | null; locations: Location[] | null;
  filters: DirectoryFilters; onFilters: (f: DirectoryFilters) => void; canManage: boolean; tabs: readonly ZonePageTab[]; onTab: (id: string) => void;
  onOpen: (id: string) => void; onAdd: () => void; onSessionEnded: () => void;
}) {
  const [text, setText] = useState(filters.q);
  const [pager, setPager] = useState<{ sig: string; stack: string[] }>({ sig: '', stack: [] });
  useEffect(() => {
    if (text.trim() === filters.q.trim()) return;
    const timer = setTimeout(() => onFilters({ ...filters, q: text.trim() }), 300);
    return () => clearTimeout(timer);
  }, [text, filters, onFilters]);

  const sig = JSON.stringify(filters);
  const stack = pager.sig === sig ? pager.stack : [];
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`employees|${slug}|${sig}|${cursor ?? ''}`, (signal) => client.list(slug, {
    q: filters.q || undefined, status: filters.status, departmentId: filters.departmentId || undefined, locationId: filters.locationId || undefined,
    sort: filters.sort, cursor, limit: PAGE_SIZE,
  }, signal));
  const page = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : null;
  const filtered = sig !== JSON.stringify(DEFAULT_FILTERS);
  const set = (patch: Partial<DirectoryFilters>) => onFilters({ ...filters, ...patch });
  const add = canManage ? <Button onClick={onAdd}>Add employee</Button> : undefined;

  return (
    <ZonePage title="Employees" eyebrow="People" description="Your team's work details, status and reporting lines." primaryActions={add} tabs={tabs} currentTab="list" onTab={onTab}>
      <div role="search" aria-label="Find employees" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Search" className="sm:col-span-2 lg:col-span-2">
          {(c) => <Input {...c} type="search" value={text} placeholder="Name, number or work email" onChange={(e) => setText(e.target.value)} />}
        </Field>
        <Field label="Status">{(c) => (
          <Select {...c} value={filters.status} onChange={(e) => set({ status: e.target.value as DirectoryFilters['status'] })}>
            <option value="current">Current (not terminated)</option><option value="all">All</option>
            {(['PENDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED'] as const).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </Select>
        )}</Field>
        <Field label="Department">{(c) => (
          <Select {...c} value={filters.departmentId} onChange={(e) => set({ departmentId: e.target.value })}>
            <option value="">All departments</option>
            {(departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Location">{(c) => (
          <Select {...c} value={filters.locationId} onChange={(e) => set({ locationId: e.target.value })}>
            <option value="">All locations</option>
            {(locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Sort by" className="sm:col-span-2 lg:col-span-1">{(c) => (
          <Select {...c} value={filters.sort} onChange={(e) => set({ sort: e.target.value as DirectoryFilters['sort'] })}>
            <option value="name">Name</option><option value="number">Employee number</option><option value="newest">Newest first</option>
          </Select>
        )}</Field>
      </div>

      {state.status === 'loading' ? (
        <div role="status" aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading employees…</span>
          {Array.from({ length: 5 }, (_, i) => <div key={i} aria-hidden="true" className="h-12 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />)}
        </div>
      ) : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Employees" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {page && page.employees.length === 0 ? (
        <EmptyState
          title={filtered ? 'No employees match these filters' : 'No employees yet'}
          description={filtered ? 'Try a different search or clear the filters.' : canManage ? 'Add your first employee to start your team directory.' : 'Employees added by your administrators will appear here.'}
          action={filtered ? <Button variant="outline" onClick={() => { setText(''); onFilters(DEFAULT_FILTERS); }}>Clear filters</Button> : add}
        />
      ) : null}
      {page && page.employees.length > 0 ? (
        <>
          <Table aria-label="Employees">
            <TableCaption>{filtered ? 'Filtered employees.' : 'Current employees.'}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead><TableHead className="hidden md:table-cell">Number</TableHead><TableHead className="hidden lg:table-cell">Job title</TableHead>
                <TableHead className="hidden md:table-cell">Department</TableHead><TableHead>Status</TableHead><TableHead className="hidden sm:table-cell">Start date</TableHead>
                <TableHead className="text-right"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.employees.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className={WRAP}>
                    <button type="button" className="text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring" onClick={() => onOpen(e.id)}>
                      {e.displayName}
                    </button>
                    <p className="text-xs text-muted-foreground md:hidden">{[e.employeeNumber, e.jobTitle].filter(Boolean).join(' · ')}</p>
                    {e.employmentType ? <p className="hidden text-xs text-muted-foreground lg:block">{TYPE_LABEL[e.employmentType]}</p> : null}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap md:table-cell">{e.employeeNumber ?? '—'}</TableCell>
                  <TableCell className={`hidden lg:table-cell ${WRAP}`}>{e.jobTitle ?? '—'}</TableCell>
                  <TableCell className={`hidden md:table-cell ${WRAP}`}>{e.department ? <>{e.department.name}{e.department.archived ? ' (archived)' : ''}</> : '—'}</TableCell>
                  <TableCell><Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge></TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">{formatDate(e.startDate, locale)}</TableCell>
                  <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => onOpen(e.id)} aria-label={`Open ${e.displayName}`}>View</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <nav aria-label="Pages" className="flex justify-between gap-3">
            <Button variant="outline" disabled={stack.length === 0} onClick={() => setPager({ sig, stack: stack.slice(0, -1) })}>Previous</Button>
            <Button variant="outline" disabled={!page.nextCursor} onClick={() => page.nextCursor && setPager({ sig, stack: [...stack, page.nextCursor] })}>Next</Button>
          </nav>
        </>
      ) : null}
    </ZonePage>
  );
}
