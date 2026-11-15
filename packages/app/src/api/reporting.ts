import {
  CreateSavedViewRequest, DeleteSavedViewResponse, endpointPath, endpoints, ListSavedViewsResponse, ReportingCatalogResponse, ReportingDetailsRequest,
  ReportingDetailsResponse, ReportingQueryRequest, ReportingQueryResponse, RunSavedViewResponse, SavedViewResponse, UpdateSavedViewRequest,
  type ReportingCatalog, type ReportingDetails, type ReportingQueryResult, type SavedView, type SavedViewListItem,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type { ReportingCatalog, ReportingDetails, ReportingQueryResult, SavedView, SavedViewListItem };
export type RunSavedView = z.infer<typeof RunSavedViewResponse>;

/**
 * Reporting Zone calls (docs/reporting-r1.md). Metrics are named by registered id and version only; the
 * business is the `:slug` in the path. Bodies are checked against the shared contract before sending and
 * every response is parsed with it. The API decides access on every call; nothing here grants any.
 */
export interface ReportingClient {
  catalog(slug: string, signal?: AbortSignal): Promise<Outcome<ReportingCatalog>>;
  query(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ReportingQueryResult>>;
  details(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ReportingDetails>>;
  views(slug: string, signal?: AbortSignal): Promise<Outcome<SavedViewListItem[]>>;
  view(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<SavedView>>;
  createView(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<SavedView>>;
  /** `patch` must include the `version` it was based on; a stale one comes back as conflict `stale`. */
  updateView(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<SavedView>>;
  deleteView(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<true>>;
  runView(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<RunSavedView>>;
}

export function createReportingClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): ReportingClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? 'Please check the report settings and try again.' };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the report settings.' });
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);

  return {
    async catalog(slug, signal) {
      return settle(await http.request('GET', p(endpoints.reportingCatalog.path, { slug }), undefined, signal), ReportingCatalogResponse, (d) => d);
    },
    async query(slug, input, signal) {
      const checked = ReportingQueryRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.runReport.path, { slug }), checked.data, signal), ReportingQueryResponse, (d) => d);
    },
    async details(slug, input, signal) {
      const checked = ReportingDetailsRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.reportDetails.path, { slug }), checked.data, signal), ReportingDetailsResponse, (d) => d);
    },
    async views(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listSavedViews.path, { slug }), undefined, signal), ListSavedViewsResponse, (d) => d.views);
    },
    async view(slug, id, signal) {
      return settle(await http.request('GET', p(endpoints.getSavedView.path, { slug, viewId: id }), undefined, signal), SavedViewResponse, (d) => d.view);
    },
    async createView(slug, input, signal) {
      const checked = CreateSavedViewRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createSavedView.path, { slug }), checked.data, signal), SavedViewResponse, (d) => d.view);
    },
    async updateView(slug, id, patch, signal) {
      const checked = UpdateSavedViewRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', p(endpoints.updateSavedView.path, { slug, viewId: id }), checked.data, signal), SavedViewResponse, (d) => d.view);
    },
    async deleteView(slug, id, signal) {
      return settle(await http.request('DELETE', p(endpoints.deleteSavedView.path, { slug, viewId: id }), undefined, signal), DeleteSavedViewResponse, () => true as const);
    },
    async runView(slug, id, signal) {
      return settle(await http.request('POST', p(endpoints.runSavedView.path, { slug, viewId: id }), undefined, signal), RunSavedViewResponse, (d) => d);
    },
  };
}
