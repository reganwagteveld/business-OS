import {
  CreateOpportunityRequest, endpointPath, endpoints, ListOpportunitiesResponse, ListOutcomesResponse, ListPipelinesResponse, ListStagesResponse,
  LoseOpportunityRequest, OpportunityResponse, PipelineResponse, ReopenOpportunityRequest, UpdateOpportunityRequest,
  type Opportunity, type OpportunityOutcome, type Pipeline, type Stage,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export interface OpportunityQuery {
  q?: string; status: 'open' | 'won' | 'lost' | 'all'; archived: 'active' | 'archived' | 'all';
  pipelineId?: string; stageId?: string; customerId?: string; cursor?: string; limit?: number;
}
export interface OpportunityPage { opportunities: Opportunity[]; nextCursor: string | null }
export interface PipelineWithStages { pipeline: Pipeline; stages: Stage[] }

/**
 * Sales Zone calls (docs/sales-data-model.md). The business is only the `:slug` in the path. Every
 * body is checked against the shared contract before it is sent; amounts are decimal strings.
 */
export interface SalesClient {
  /** Read only: empty until the default pipeline has been set up. */
  pipelines(slug: string, signal?: AbortSignal): Promise<Outcome<Pipeline[]>>;
  /** Explicit, idempotent set-up of the default pipeline (POST). Safe to repeat. */
  initialiseDefault(slug: string, signal?: AbortSignal): Promise<Outcome<PipelineWithStages>>;
  stages(slug: string, pipelineId: string, signal?: AbortSignal): Promise<Outcome<PipelineWithStages>>;
  list(slug: string, query: OpportunityQuery, signal?: AbortSignal): Promise<Outcome<OpportunityPage>>;
  get(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  create(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  win(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  lose(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  reopen(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  archive(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  restore(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Opportunity>>;
  outcomes(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<OpportunityOutcome[]>>;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createSalesClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): SalesClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? (body?.error === 'invalid_cursor' ? 'That page is no longer valid. Start again from the first page.' : 'Please check the details and try again.') };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, String(v));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const opp = (template: string, slug: string, id: string) => p(template, { slug, opportunityId: id });

  return {
    async pipelines(slug, signal) {
      return settle(await http.request('GET', p(endpoints.listPipelines.path, { slug }), undefined, signal), ListPipelinesResponse, (d) => d.pipelines);
    },
    async initialiseDefault(slug, signal) {
      return settle(await http.request('POST', p(endpoints.initialiseDefaultPipeline.path, { slug }), undefined, signal), PipelineResponse, (d) => d);
    },
    async stages(slug, pipelineId, signal) {
      return settle(await http.request('GET', p(endpoints.listStages.path, { slug }) + qs({ pipelineId }), undefined, signal), ListStagesResponse, (d) => d);
    },
    async list(slug, query, signal) {
      const raw = await http.request('GET', p(endpoints.listOpportunities.path, { slug }) + qs({
        q: query.q?.trim(), status: query.status, archived: query.archived, pipelineId: query.pipelineId, stageId: query.stageId,
        customerId: query.customerId, cursor: query.cursor, limit: query.limit,
      }), undefined, signal);
      return settle(raw, ListOpportunitiesResponse, (d) => d);
    },
    async get(slug, id, signal) {
      return settle(await http.request('GET', opp(endpoints.getOpportunity.path, slug, id), undefined, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async create(slug, input, signal) {
      const checked = CreateOpportunityRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createOpportunity.path, { slug }), checked.data, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async update(slug, id, patch, signal) {
      const checked = UpdateOpportunityRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', opp(endpoints.updateOpportunity.path, slug, id), checked.data, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async win(slug, id, signal) {
      return settle(await http.request('POST', opp(endpoints.winOpportunity.path, slug, id), undefined, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async lose(slug, id, input, signal) {
      const checked = LoseOpportunityRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', opp(endpoints.loseOpportunity.path, slug, id), checked.data, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async reopen(slug, id, input, signal) {
      const checked = ReopenOpportunityRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', opp(endpoints.reopenOpportunity.path, slug, id), checked.data, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async archive(slug, id, signal) {
      return settle(await http.request('POST', opp(endpoints.archiveOpportunity.path, slug, id), undefined, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async restore(slug, id, signal) {
      return settle(await http.request('POST', opp(endpoints.restoreOpportunity.path, slug, id), undefined, signal), OpportunityResponse, (d) => d.opportunity);
    },
    async outcomes(slug, id, signal) {
      return settle(await http.request('GET', opp(endpoints.listOpportunityOutcomes.path, slug, id), undefined, signal), ListOutcomesResponse, (d) => d.outcomes);
    },
  };
}
