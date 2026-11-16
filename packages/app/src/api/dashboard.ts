import {
  endpointPath, endpoints, ListActivitiesResponse, ListEventsResponse, SalesSummaryResponse,
  type Activity, type SalesSummary, type SchedulingEvent,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type { SalesSummary };

/** One bounded page: the rows, and whether the server has more beyond them. Never followed further. */
export interface BoundedPage<T> { items: T[]; more: boolean }

/**
 * Reads used only by the operational dashboard on Home (docs/dashboard-r2.md). Each one is a single,
 * bounded request answered by an existing Zone endpoint (or, for the pipeline, the Sales Zone's grouped
 * summary); nothing here follows cursors or fetches records one by one. Figures the other Zone clients
 * already provide (Reporting metrics, project counts, overdue invoices) are read through those clients.
 * The business is only the `:slug` in the path; the API checks every permission again.
 */
export interface DashboardClient {
  /** The open pipeline as totals by pipeline, stage and currency (sales:read). */
  salesSummary(slug: string, signal?: AbortSignal): Promise<Outcome<SalesSummary>>;
  /** The newest entries of the business-wide activity timeline, as the person may see them (activity:read). */
  recentActivity(slug: string, limit: number, signal?: AbortSignal): Promise<Outcome<BoundedPage<Activity>>>;
  /** Scheduled events overlapping [from, to), ordered by start; one page of at most `limit` (scheduling:read). */
  upcomingEvents(slug: string, range: { from: string; to: string; limit: number }, signal?: AbortSignal): Promise<Outcome<BoundedPage<SchedulingEvent>>>;
}

export function createDashboardClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): DashboardClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? 'The request was not accepted.' };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const qs = (values: Record<string, string>) => `?${new URLSearchParams(values).toString()}`;
  const p = (template: string, slug: string) => endpointPath(template, { slug });

  return {
    async salesSummary(slug, signal) {
      return settle(await http.request('GET', p(endpoints.salesSummary.path, slug), undefined, signal), SalesSummaryResponse, (d) => d.summary);
    },
    async recentActivity(slug, limit, signal) {
      const raw = await http.request('GET', p(endpoints.listActivities.path, slug) + qs({ limit: String(limit) }), undefined, signal);
      return settle(raw, ListActivitiesResponse, (d) => ({ items: d.activities, more: d.nextCursor !== null }));
    },
    async upcomingEvents(slug, range, signal) {
      const raw = await http.request('GET', p(endpoints.listEvents.path, slug) + qs({ from: range.from, to: range.to, status: 'scheduled', limit: String(range.limit) }), undefined, signal);
      return settle(raw, ListEventsResponse, (d) => ({ items: d.events, more: d.nextCursor !== null }));
    },
  };
}
