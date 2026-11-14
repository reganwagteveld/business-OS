/**
 * A stand-in for the PR 15 Sales API, for tests only. It wraps the Customer Zone test API (so both
 * share one call log and one set of customers, contacts and members) and follows the server's rules:
 * explicit default-pipeline set-up, strict bodies, versioned edits, conditional status changes and an
 * append-only outcome history. The app's real Sales client and contracts sit in front of it.
 */
import {
  CreateOpportunityRequest, LoseOpportunityRequest, ReopenOpportunityRequest, UpdateOpportunityRequest,
  type Opportunity, type OpportunityOutcome, type Pipeline, type Stage,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import type { createFakeApi } from './fake-api';

export interface FakeSales { currency: string; pipelines: { pipeline: Pipeline; stages: Stage[] }[]; opportunities: Opportunity[]; outcomes: (OpportunityOutcome & { opportunityId: string })[] }
export const emptySales = (currency = 'AUD'): FakeSales => ({ currency, pipelines: [], opportunities: [], outcomes: [] });

const NOW = '2026-11-14T03:00:00.000Z';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cursorOf = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
const offsetOf = (cursor: string | null) => (cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o: number }).o : 0);
const digits = (currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
/** Same output as the server: the stored decimal with the currency's own number of decimals. Exact (string maths). */
function fix(amount: string, currency: string): string {
  const d = digits(currency);
  const [whole, frac = ''] = amount.split('.');
  return d === 0 ? whole! : `${whole}.${(frac + '0'.repeat(d)).slice(0, d)}`;
}

export function pipelineWithStages(name = 'Sales pipeline', isDefault = true): { pipeline: Pipeline; stages: Stage[] } {
  const id = randomUUID();
  const stages = [['New', 10], ['Qualified', 25], ['Proposal', 50], ['Negotiation', 75]].map(([n, p], i) => ({
    id: randomUUID(), pipelineId: id, name: n as string, position: (i + 1) * 1000, defaultProbability: p as number, archivedAt: null,
  }));
  return { pipeline: { id, name, isDefault, position: 0, createdAt: NOW, updatedAt: NOW, archivedAt: null }, stages };
}

export function opportunity(entry: { pipeline: Pipeline; stages: Stage[] }, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: randomUUID(), title: 'Opportunity', customerId: null, contactId: null, pipelineId: entry.pipeline.id, stageId: entry.stages[0]!.id,
    amount: null, currencyCode: 'AUD', probability: null, expectedCloseDate: null, ownerUserId: null, description: null, status: 'OPEN',
    lossReason: null, closedAt: null, version: 1, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  };
}

export function withSales(api: ReturnType<typeof createFakeApi>, sales: Record<string, FakeSales>) {
  const base = api.fetch;
  let clock = Date.parse('2026-11-14T04:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)\/sales\/(pipelines|stages|opportunities)(?:\/([^/]+))?(?:\/([a-z]+))?$/.exec(url.pathname);
    if (!m) return base(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, slug: m[1]!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: (init?.headers ?? {}) as Record<string, string> });
    const rule = (api as unknown as { _salesNext?: ((path: string, method: string) => Response | 'network' | undefined)[] })._salesNext?.shift()?.(url.pathname, method);
    if (rule === 'network') throw new TypeError('Failed to fetch');
    if (rule) return rule;
    const s = sales[m[1]!];
    const biz = api.businesses[m[1]!];
    if (!s || !biz) return json(404, { error: 'not_found' });
    const [, , resource, id, action] = m;
    const def = () => s.pipelines.find((p) => p.pipeline.isDefault);
    const ensureDefault = () => def() ?? (s.pipelines.push(pipelineWithStages()), def()!);

    if (resource === 'pipelines') {
      if (method === 'GET' && !id) return json(200, { pipelines: s.pipelines.filter((p) => !p.pipeline.archivedAt).map((p) => p.pipeline) });
      if (method === 'POST' && id === 'default') {
        const existed = Boolean(def());
        const entry = ensureDefault();
        return json(existed ? 200 : 201, entry);
      }
      return json(404, { error: 'not_found' });
    }
    if (resource === 'stages') {
      const pid = url.searchParams.get('pipelineId');
      const entry = pid ? s.pipelines.find((p) => p.pipeline.id === pid) : def();
      return entry ? json(200, { pipeline: entry.pipeline, stages: entry.stages.filter((x) => !x.archivedAt) }) : json(404, { error: 'not_found' });
    }

    // opportunities
    if (!id && method === 'GET') {
      const q = url.searchParams;
      const term = q.get('q')?.toLowerCase();
      const rows = s.opportunities
        .filter((o) => (q.get('status') ?? 'all') === 'all' || o.status === q.get('status')!.toUpperCase())
        .filter((o) => ((q.get('archived') ?? 'active') === 'all' ? true : q.get('archived') === 'archived' ? o.archivedAt : !o.archivedAt))
        .filter((o) => !q.get('pipelineId') || o.pipelineId === q.get('pipelineId'))
        .filter((o) => !q.get('stageId') || o.stageId === q.get('stageId'))
        .filter((o) => !q.get('customerId') || o.customerId === q.get('customerId'))
        .filter((o) => !term || o.title.toLowerCase().includes(term))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const start = offsetOf(q.get('cursor'));
      const limit = Number(q.get('limit') ?? 25);
      return json(200, { opportunities: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? cursorOf(start + limit) : null });
    }
    if (!id && method === 'POST') {
      const parsed = CreateOpportunityRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      const d = parsed.data;
      const entry = d.pipelineId ? s.pipelines.find((p) => p.pipeline.id === d.pipelineId) : ensureDefault();
      if (!entry) return json(404, { error: 'not_found' });
      if (d.stageId && !entry.stages.some((x) => x.id === d.stageId)) return json(400, { error: 'invalid_stage', message: 'Choose a stage of this pipeline.' });
      let customerId = d.customerId ?? null;
      if (customerId) {
        const c = biz.customers.find((x) => x.id === customerId);
        if (!c) return json(404, { error: 'not_found' });
        if (c.archivedAt) return json(409, { error: 'archived_reference' });
      }
      if (d.contactId) {
        const k = biz.contacts.find((x) => x.id === d.contactId);
        if (!k) return json(404, { error: 'not_found' });
        if (k.customerId && customerId && k.customerId !== customerId) return json(400, { error: 'contact_customer_mismatch', message: 'This contact belongs to a different customer.' });
        customerId = customerId ?? k.customerId;
      }
      const currency = d.currencyCode ?? s.currency;
      if (d.amount && (d.amount.split('.')[1] ?? '').replace(/0+$/, '').length > digits(currency)) return json(400, { error: 'invalid_amount', message: `${currency} amounts have at most ${digits(currency)} decimal places.` });
      const now = tick();
      const row = opportunity(entry, {
        title: d.title, customerId, contactId: d.contactId ?? null, stageId: d.stageId ?? entry.stages[0]!.id, amount: d.amount ? fix(d.amount, currency) : null,
        currencyCode: currency, probability: d.probability ?? null, expectedCloseDate: d.expectedCloseDate ?? null, ownerUserId: d.ownerUserId ?? null,
        description: d.description ?? null, createdAt: now, updatedAt: now,
      });
      s.opportunities.push(row);
      return json(201, { opportunity: row });
    }
    const found = s.opportunities.find((o) => o.id === id);
    if (!found) return json(404, { error: 'not_found' });
    const bump = (patch: Partial<Opportunity>) => Object.assign(found, patch, { version: found.version + 1, updatedAt: tick() });
    if (!action && method === 'GET') return json(200, { opportunity: found });
    if (!action && method === 'PATCH') {
      const parsed = UpdateOpportunityRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      const { version, ...patch } = parsed.data;
      if (found.archivedAt) return json(409, { error: 'archived' });
      if (found.version !== version) return json(409, { error: 'stale' });
      if (patch.stageId && patch.stageId !== found.stageId && found.status !== 'OPEN') return json(409, { error: 'not_open' });
      const next: Partial<Opportunity> = { ...(patch as Partial<Opportunity>) };
      if (patch.amount) next.amount = fix(patch.amount, patch.currencyCode ?? found.currencyCode);
      bump(next);
      return json(200, { opportunity: found });
    }
    const outcome = (status: 'WON' | 'LOST', lossReason: string | null) => {
      const closedAt = tick();
      bump({ status, closedAt, lossReason });
      s.outcomes.unshift({ id: randomUUID(), opportunityId: found.id, status, lossReason, stageId: found.stageId, amount: found.amount, currencyCode: found.currencyCode, closedAt, closedById: null, reopenedAt: null, reopenedById: null });
      return json(200, { opportunity: found });
    };
    if (method === 'POST' && (action === 'win' || action === 'lose')) {
      if (found.archivedAt) return json(409, { error: 'archived' });
      if (found.status !== 'OPEN') return json(409, { error: 'not_open' });
      if (action === 'win') return outcome('WON', null);
      const parsed = LoseOpportunityRequest.safeParse(body ?? {});
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      return outcome('LOST', parsed.data.lossReason ?? null);
    }
    if (method === 'POST' && action === 'reopen') {
      const parsed = ReopenOpportunityRequest.safeParse(body ?? {});
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (found.archivedAt) return json(409, { error: 'archived' });
      if (found.status === 'OPEN') return json(409, { error: 'not_closed' });
      bump({ status: 'OPEN', closedAt: null, lossReason: null, stageId: parsed.data.stageId ?? found.stageId });
      const latest = s.outcomes.find((h) => h.opportunityId === found.id && !h.reopenedAt);
      if (latest) latest.reopenedAt = tick();
      return json(200, { opportunity: found });
    }
    if (method === 'POST' && action === 'archive') {
      if (found.archivedAt) return json(409, { error: 'archived' });
      bump({ archivedAt: tick() });
      return json(200, { opportunity: found });
    }
    if (method === 'POST' && action === 'restore') {
      if (!found.archivedAt) return json(409, { error: 'not_archived' });
      bump({ archivedAt: null });
      return json(200, { opportunity: found });
    }
    if (method === 'GET' && action === 'outcomes') {
      return json(200, { outcomes: s.outcomes.filter((h) => h.opportunityId === found.id).map((h) => { const { opportunityId, ...rest } = h; void opportunityId; return rest; }) });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return Object.assign(api, {
    sales,
    /** Answer the next Sales request yourself. */
    salesNext(handler: (path: string, method: string) => Response | 'network' | undefined) {
      const self = api as unknown as { _salesNext?: ((path: string, method: string) => Response | 'network' | undefined)[] };
      (self._salesNext ??= []).push(handler);
    },
  });
}
