import type { ReportingMetricDefinition, SavedView, SavedViewListItem } from '@business-os/contracts';
import { Alert, AlertDescription, AlertTitle, Badge, Button, EmptyState, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@business-os/ui';
import { useState } from 'react';
import type { ReportingClient } from '../../api/reporting';
import type { Loaded } from '../use-load';
import { formatWhen } from '../sales/format';
import { Problem, Skeleton } from '../problem';

export type SavedScope = 'all' | 'mine' | 'shared';

/** Whose report it is and who sees it, in the words the list uses. Never inferred from anything but the API's `isOwner` and `visibility`. */
export function ownership(v: Pick<SavedViewListItem, 'isOwner' | 'visibility'>): { label: string; tone: 'neutral' | 'info' | 'brand'; help: string } {
  if (v.isOwner && v.visibility === 'PRIVATE') return { label: 'Private', tone: 'neutral', help: 'Only you can see it.' };
  if (v.isOwner) return { label: 'Shared by you', tone: 'info', help: 'Everyone in this business can open it and sees only the data their own role allows.' };
  return { label: 'Shared with you', tone: 'brand', help: 'Another person in this business owns it. You can open it; only they can change it.' };
}

/**
 * What this person may do with a saved report, by R1's rules (docs/reporting-r1.md §6): the owner edits,
 * shares (with reporting:share) and deletes (all need reporting:save); reporting:manage also deletes other
 * people's shared reports. Presentation only: the API checks every request.
 */
export function savedActions(v: Pick<SavedViewListItem, 'isOwner' | 'visibility'>, can: { save: boolean; share: boolean; manage: boolean }) {
  return {
    rename: v.isOwner && can.save,
    delete: (v.isOwner && can.save) || (!v.isOwner && v.visibility === 'BUSINESS' && can.manage),
  };
}

/**
 * Saved reports (R2): every report this person can open, from R1's list endpoint (all pages, or an explicit
 * "could not all be listed"). Filtering by scope happens on that already-complete list, so it needs no
 * further requests. Opening a report runs it in Explore through the saved-view endpoint.
 */
export function SavedReports({ state, reload, catalog, can, timeZone, locale, client, slug, onOpen, onNew, onRename, onDelete, onSessionEnded }: {
  state: Loaded<SavedViewListItem[]>; reload: () => void; catalog: ReportingMetricDefinition[]; can: { save: boolean; share: boolean; manage: boolean };
  timeZone: string; locale?: string; client: ReportingClient; slug: string;
  onOpen: (id: string) => void; onNew?: () => void; onRename: (view: SavedView) => void; onDelete: (view: SavedView) => void; onSessionEnded: () => void;
}) {
  const [scope, setScope] = useState<SavedScope>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'loading') return <Skeleton rows={4} label="Loading saved reports" />;
  const outcome = state.outcome;
  if (outcome.kind !== 'ok' && outcome.kind !== 'incomplete') return <Problem outcome={outcome} what="Saved reports" onRetry={reload} onSessionEnded={onSessionEnded} />;
  if (outcome.kind === 'incomplete') {
    return (
      <Alert tone="warning" className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <AlertTitle>Saved reports could not all be listed</AlertTitle>
          <AlertDescription>{outcome.message}</AlertDescription>
        </div>
        <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
      </Alert>
    );
  }
  const all = outcome.data;
  const counts = { all: all.length, mine: all.filter((v) => v.isOwner).length, shared: all.filter((v) => !v.isOwner).length };
  const list = all.filter((v) => (scope === 'all' ? true : scope === 'mine' ? v.isOwner : !v.isOwner));
  const metricName = (id: string) => catalog.find((m) => m.id === id)?.name ?? id;

  // Rename and delete need the full view (its current version); fetching it also re-checks access.
  const withView = async (id: string, then: (view: SavedView) => void) => {
    setBusy(id);
    setError(null);
    const out = await client.view(slug, id);
    setBusy(null);
    if (out.kind === 'ok') then(out.data);
    else if (out.kind === 'unauthenticated') onSessionEnded();
    else setError(out.kind === 'not_found' ? 'That report is no longer available to you.' : 'That report could not be opened. Try again.');
  };

  if (all.length === 0) {
    return (
      <EmptyState title="No saved reports yet"
        description={can.save ? 'Set up a report in Explore and save it. Saved reports keep the settings, not the figures, and recalculate each time they are opened.' : 'Reports shared with everyone in this business will appear here.'}
        action={onNew ? <Button onClick={onNew}>Create a report</Button> : undefined} />
    );
  }

  const SCOPES: { id: SavedScope; label: string }[] = [
    { id: 'all', label: `All (${counts.all})` }, { id: 'mine', label: `Mine (${counts.mine})` }, { id: 'shared', label: `Shared with me (${counts.shared})` },
  ];
  return (
    <div className="space-y-4">
      <div role="group" aria-label="Show reports" className="flex flex-wrap gap-2">
        {SCOPES.map((s) => <Button key={s.id} size="sm" variant={scope === s.id ? 'secondary' : 'ghost'} aria-pressed={scope === s.id} onClick={() => setScope(s.id)}>{s.label}</Button>)}
      </div>
      {error ? <p role="alert" className="text-sm font-medium text-destructive">{error}</p> : null}
      {list.length === 0 ? (
        <EmptyState title={scope === 'mine' ? 'You have not saved any reports' : 'Nobody has shared a report with you'} />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableCaption>{list.length} saved report{list.length === 1 ? '' : 's'}, most recently updated first. Each report runs with your own access.</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Report</TableHead>
                <TableHead>Figure</TableHead>
                <TableHead>Who can see it</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((v) => {
                const own = ownership(v);
                const act = savedActions(v, can);
                return (
                  <TableRow key={v.id}>
                    <TableCell className="min-w-48 align-top">
                      <button type="button" className="text-left font-medium underline-offset-4 hover:underline" onClick={() => onOpen(v.id)}>{v.title}</button>
                      {v.description ? <p className="text-xs text-muted-foreground">{v.description}</p> : null}
                      {v.issues.map((i) => <p key={i} className="mt-1 text-xs font-medium text-warning">Needs attention: {i}</p>)}
                    </TableCell>
                    <TableCell className="align-top">{v.metrics.map((m) => metricName(m.id)).join(', ')}</TableCell>
                    <TableCell className="align-top">
                      <Badge tone={own.tone}>{own.label}</Badge>
                      <p className="mt-1 max-w-56 text-xs text-muted-foreground">{own.help}</p>
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">{formatWhen(v.updatedAt, timeZone, locale)}</TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => onOpen(v.id)} aria-label={`Open ${v.title}`}>Open</Button>
                        {act.rename ? <Button size="sm" variant="ghost" loading={busy === v.id} onClick={() => void withView(v.id, onRename)} aria-label={`Rename or share ${v.title}`}>{can.share ? 'Rename or share' : 'Rename'}</Button> : null}
                        {act.delete ? <Button size="sm" variant="ghost" onClick={() => void withView(v.id, onDelete)} aria-label={`Delete ${v.title}`}>Delete</Button> : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
