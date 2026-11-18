import { z } from 'zod';
import { CalendarDate } from './sales.ts';
import { ProjectStatus, WorkPriority } from './projects.ts';

// Cross-Zone workflows (docs/cross-zone-workflows-wf1.md §6.2–6.4, LC-1 = WF-1B-2). Every path is under
// /api/v1/b/:slug/workflows. Bodies are strict. Responses are the Projects Zone's ProjectResponse, with the
// same field-level redaction (sourceQuote* absent without finance:read, sourceOpportunity* absent without
// sales:read). New 409 codes: opportunity_projects_changed, quote_not_accepted, quote_has_project,
// project_has_quote, opportunity_set_by_quote, opportunity_mismatch, opportunity_lost (§6.9).

const Uuid = z.string().uuid();
const dateOrder = (v: { startDate?: string | null; dueDate?: string | null }) => !v.startDate || !v.dueDate || v.dueDate >= v.startDate;
const DATE_ORDER = { message: 'The due date cannot be before the start date', path: ['dueDate'] };

/** Optional project details for a project made from another record; anything left out takes the Projects defaults. */
const detailFields = {
  /** Defaults to the opportunity title, or to the quote number (plus the customer name). */
  name: z.string().trim().min(1, 'A project name is required').max(200).optional(),
  ownerUserId: Uuid.nullable().optional(),
  startDate: CalendarDate.nullable().optional(),
  dueDate: CalendarDate.nullable().optional(),
  status: ProjectStatus.optional(),
  priority: WorkPriority.optional(),
};

/**
 * §6.2: Idempotency-Key header required. `existingProjectCount` is how many projects (archived included)
 * the person saw made from this opportunity; if it changed, 409 opportunity_projects_changed and nothing
 * is created (D-WF1-15). Needs projects:create + sales:read (+ customers:read when the opportunity has a customer).
 */
export const ProjectFromOpportunityRequest = z
  .object({ opportunityId: Uuid, existingProjectCount: z.number().int().min(0).max(10_000), ...detailFields })
  .strict()
  .refine(dateOrder, DATE_ORDER);
export type ProjectFromOpportunityRequest = z.infer<typeof ProjectFromOpportunityRequest>;

/** §6.3: Idempotency-Key header required. The quote must be ACCEPTED. Needs projects:create + finance:read + customers:read. */
export const ProjectFromQuoteRequest = z.object({ quoteId: Uuid, ...detailFields }).strict().refine(dateOrder, DATE_ORDER);
export type ProjectFromQuoteRequest = z.infer<typeof ProjectFromQuoteRequest>;

/** §6.4: set, change or clear (null) the project's source opportunity. Needs projects:update + sales:read. */
export const LinkProjectOpportunityRequest = z.object({ version: z.number().int().min(1), opportunityId: Uuid.nullable() }).strict();
export type LinkProjectOpportunityRequest = z.infer<typeof LinkProjectOpportunityRequest>;

/** §6.4: associate an ACCEPTED quote once (no unlink, D-WF1-09). Needs projects:update + finance:read. */
export const LinkProjectQuoteRequest = z.object({ version: z.number().int().min(1), quoteId: Uuid }).strict();
export type LinkProjectQuoteRequest = z.infer<typeof LinkProjectQuoteRequest>;
