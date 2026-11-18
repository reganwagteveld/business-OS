import 'server-only';
// Project workflows (docs/cross-zone-workflows-wf1.md §6.2–6.4, §6.10, §8; LC-1 = WF-1B-2). Each action runs
// in one tenant unit of work: the project, its workflow_requests row and its audit rows commit together or
// not at all (§8). The other Zone's record is checked here, under the lock order of §6.10; the project row
// is written by the Projects Zone. The composite FKs and the projects_guard_links trigger (§5.4) are the
// database backstop for every rule checked here.
//
// Field-level redaction is the Projects Zone's (WF-1 §6.7): every response is that Zone's project, read
// back with the caller's current permissions, so sourceQuote* stays absent without finance:read (G-FIN).
// No error here names another Zone's record, kind, count or id.
import type {
  LinkProjectOpportunityRequest, LinkProjectQuoteRequest, ProjectFromOpportunityRequest, ProjectFromQuoteRequest,
} from '@business-os/contracts';
import { ForbiddenError } from '@/modules/access';
import {
  countOpportunityProjects, createProject, getProject, projectLinks, setProjectOpportunity, setProjectQuote, type Viewer,
} from '@/modules/projects';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { isUniqueViolation, RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { claimKey, recordKey, requestHash } from './requests';

export { workflowIdempotencyKey } from './requests';

type QuoteRow = {
  id: string; kind: string; status: string; number: string | null; customer_id: string; project_id: string | null; opportunity_id: string | null;
};

/**
 * Reads a quote under a row lock (§6.10): FOR NO KEY UPDATE for from-quote (P4, held strong so a concurrent
 * void or a second create queues behind it), FOR SHARE for link-quote (P3, blocks a concurrent void).
 * Tagged $queryRaw on the tenant client: same transaction, bos_app, forced RLS plus an explicit business_id
 * predicate. Anything that is not a quote of this business is 404.
 */
async function lockQuote(db: AppTenantDb, id: string, mode: 'update' | 'share'): Promise<QuoteRow> {
  const rows = mode === 'update'
    ? await db.$queryRaw<QuoteRow[]>`
        SELECT id::text, kind::text, status::text, number, customer_id::text, project_id::text, opportunity_id::text
          FROM finance_documents
         WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
           FOR NO KEY UPDATE`
    : await db.$queryRaw<QuoteRow[]>`
        SELECT id::text, kind::text, status::text, number, customer_id::text, project_id::text, opportunity_id::text
          FROM finance_documents
         WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
           FOR SHARE`;
  const quote = rows[0];
  if (!quote || quote.kind !== 'QUOTE') throw new RecordNotFoundError();
  return quote;
}

/** Another project already has this quote as its source (W1-D10: one project per quote). */
async function quoteIsSource(db: AppTenantDb, quoteId: string, exceptProjectId?: string) {
  const other = await db.project.findFirst({
    where: { sourceQuoteId: quoteId, ...(exceptProjectId ? { id: { not: exceptProjectId } } : {}) } as never, select: { id: true },
  });
  return other !== null;
}

/** The opportunity a project may newly link (D-WF1-16): exists here, not archived, OPEN or WON. */
async function linkableOpportunity(db: AppTenantDb, id: string) {
  const opportunity = await db.opportunity.findFirst({ where: { id }, select: { id: true, title: true, status: true, customerId: true, archivedAt: true } });
  if (!opportunity) throw new RecordNotFoundError();
  if (opportunity.archivedAt) throw new StateConflictError('archived_reference');
  if (opportunity.status === 'LOST') throw new StateConflictError('opportunity_lost');
  return opportunity;
}

/** The unique source-quote key is the backstop behind the service check (a race with a direct-SQL link). */
async function sourceQuoteKey<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (isUniqueViolation(error, 'projects_source_quote_key')) throw new StateConflictError('quote_has_project');
    throw error;
  }
}

/** The optional project details a workflow create passes through to the Projects Zone unchanged. */
const details = ({ ownerUserId, startDate, dueDate, status, priority }: Omit<ProjectFromQuoteRequest, 'quoteId'>) => ({ ownerUserId, startDate, dueDate, status, priority });

/**
 * §6.2 Create project from opportunity. Lock order (P7): key lock → advisory lock on the opportunity's
 * project set → opportunity read (no row lock; Sales edits are not blocked) → project insert (FK KEY SHARE).
 * The duplicate guard (D-WF1-15) compares the person's count with the count under that lock, so a double
 * click, a stale screen or a retry after the key's retention cannot silently add a project; a person who saw
 * the new count and confirms again does create another one (phased work, D-WF1-03).
 */
export async function projectFromOpportunity(
  db: AppTenantDb, viewer: Viewer, actorUserId: string, key: string, input: ProjectFromOpportunityRequest,
): Promise<{ status: 200 | 201; project: Awaited<ReturnType<typeof getProject>> }> {
  const operation = 'project.from_opportunity';
  const hash = requestHash(operation, input);
  const replay = await claimKey(db, operation, key, hash);
  if (replay) return { status: 200, project: await getProject(db, viewer, replay) };

  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
      'workflows.opportunity_projects:' || current_setting('app.business_id', true) || ':' || ${input.opportunityId}::text, 0))) AS l`;
  const opportunity = await linkableOpportunity(db, input.opportunityId);
  // The customer is copied from the opportunity, so the Projects rule applies: linking a customer needs customers:read.
  if (opportunity.customerId && !viewer.canReadCustomers) throw new ForbiddenError();
  const count = await countOpportunityProjects(db, opportunity.id);
  if (count !== input.existingProjectCount) throw new StateConflictError('opportunity_projects_changed');

  const project = await createProject(db, viewer, actorUserId, {
    name: input.name ?? opportunity.title, customerId: opportunity.customerId, ...details(input),
  }, { sourceOpportunityId: opportunity.id });
  await recordKey(db, operation, key, hash, project.id, actorUserId);
  // Structured ids only, never names or amounts; alongside the Projects Zone's own projects.project.created.
  await recordAudit(db, actorUserId, 'projects.project.created_from_opportunity', { type: 'project', id: project.id }, { opportunityId: opportunity.id });
  return { status: 201, project };
}

/**
 * §6.3 Create project from an accepted quote (W1-D2). Lock order (P4): key lock → quote FOR NO KEY UPDATE →
 * project insert (the trigger re-takes the quote FOR SHARE, compatible with our own lock; FK KEY SHARE on
 * quote, customer, opportunity). A concurrent void waits for us or we see its VOID; a second create for the
 * same quote waits and then sees ours (409 quote_has_project).
 */
export async function projectFromQuote(
  db: AppTenantDb, viewer: Viewer, actorUserId: string, key: string, input: ProjectFromQuoteRequest,
): Promise<{ status: 200 | 201; project: Awaited<ReturnType<typeof getProject>> }> {
  const operation = 'project.from_quote';
  const hash = requestHash(operation, input);
  const replay = await claimKey(db, operation, key, hash);
  if (replay) return { status: 200, project: await getProject(db, viewer, replay) };

  const quote = await lockQuote(db, input.quoteId, 'update');
  if (quote.status !== 'ACCEPTED') throw new StateConflictError('quote_not_accepted');
  if (quote.project_id !== null || await quoteIsSource(db, quote.id)) throw new StateConflictError('quote_has_project');

  let name = input.name;
  if (!name) {
    // W1 §8.2: the quote number, plus the customer's name only for a caller who may read customers.
    const customer = viewer.canReadCustomers ? await db.customer.findFirst({ where: { id: quote.customer_id }, select: { displayName: true } }) : null;
    name = [quote.number ?? 'Quote', customer?.displayName].filter(Boolean).join(' – ').slice(0, 200);
  }
  const project = await sourceQuoteKey(createProject(db, viewer, actorUserId, { name, customerId: quote.customer_id, ...details(input) }, {
    sourceQuoteId: quote.id, sourceOpportunityId: quote.opportunity_id,
  }));
  await recordKey(db, operation, key, hash, project.id, actorUserId);
  await recordAudit(db, actorUserId, 'projects.project.created_from_quote', { type: 'project', id: project.id }, {
    quoteId: quote.id, opportunityId: quote.opportunity_id,
  });
  return { status: 201, project };
}

/**
 * §6.4 link-opportunity (D-WF1-07): set, change or clear. Same value again is a no-op (200, no version bump,
 * no audit). Locked while the source quote fixes the opportunity (409 opportunity_set_by_quote). Lock order
 * (P6): project row FOR NO KEY UPDATE by the conditional update; the opportunity is not locked (FK KEY SHARE).
 */
export async function linkProjectOpportunity(
  db: AppTenantDb, viewer: Viewer, actorUserId: string, projectId: string, input: LinkProjectOpportunityRequest,
) {
  const project = await projectLinks(db, projectId);
  if (project.archived) throw new StateConflictError('archived');
  if (project.sourceOpportunityId === input.opportunityId) return getProject(db, viewer, projectId);
  if (project.version !== input.version) throw new StateConflictError('stale');
  if (project.sourceQuoteId !== null) {
    // The quote's opportunity is frozen after issue (finance_guard_document), so this read needs no lock.
    const quote = await db.financeDocument.findFirst({ where: { id: project.sourceQuoteId }, select: { opportunityId: true } });
    if (quote?.opportunityId) throw new StateConflictError('opportunity_set_by_quote');
  }
  if (input.opportunityId !== null) {
    const opportunity = await linkableOpportunity(db, input.opportunityId);
    if (opportunity.customerId !== null && project.customerId !== null && opportunity.customerId !== project.customerId) {
      throw new RuleViolationError('opportunity_customer_mismatch', 'This opportunity is for a different customer.');
    }
  }
  return setProjectOpportunity(db, viewer, actorUserId, project, input.version, input.opportunityId);
}

/**
 * §6.4 link-quote (D-WF1-08): associate an ACCEPTED quote of the same customer once. The same quote again is a
 * no-op. Lock order (P3): quote FOR SHARE (a concurrent void waits, or we see its VOID) → project conditional
 * update (FOR UPDATE, a unique-key column changes) → the trigger re-takes the quote lock and re-checks (§5.4).
 */
export async function linkProjectQuote(db: AppTenantDb, viewer: Viewer, actorUserId: string, projectId: string, input: LinkProjectQuoteRequest) {
  const quote = await lockQuote(db, input.quoteId, 'share');
  const project = await projectLinks(db, projectId);
  if (project.archived) throw new StateConflictError('archived');
  if (project.sourceQuoteId === quote.id) return getProject(db, viewer, projectId);
  if (project.sourceQuoteId !== null) throw new StateConflictError('project_has_quote');
  if (project.customerId === null || project.customerId !== quote.customer_id) {
    throw new RuleViolationError('project_customer_mismatch', 'This quote is for a different customer than the project.');
  }
  if (quote.status !== 'ACCEPTED') throw new StateConflictError('quote_not_accepted');
  if ((quote.project_id !== null && quote.project_id !== project.id) || await quoteIsSource(db, quote.id, project.id)) {
    throw new StateConflictError('quote_has_project');
  }
  if (quote.opportunity_id !== null && project.sourceOpportunityId !== null && project.sourceOpportunityId !== quote.opportunity_id) {
    throw new StateConflictError('opportunity_mismatch');
  }
  if (project.version !== input.version) throw new StateConflictError('stale');
  return sourceQuoteKey(setProjectQuote(db, viewer, actorUserId, project, input.version, quote.id, quote.opportunity_id));
}
