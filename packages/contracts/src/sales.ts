import { z } from 'zod';

// Sales Zone (docs/sales-data-model.md). Every path is under /api/v1/b/:slug, so no request carries a
// business id, and bodies are strict: an unknown field (a business id, an author, a status, a close
// date) is rejected rather than ignored.

const Uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

/**
 * Money is an exact decimal string, never a JSON number (no binary floating point anywhere):
 * up to 14 whole digits and 4 decimals, not negative. The server also checks the decimals against
 * the currency's own minor unit (for example 0 for JPY, 3 for KWD).
 */
export const Money = z.string().trim().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Enter an amount such as 1250 or 1250.50');
/** ISO 4217 code. The server checks it is a real currency. No currency is assumed. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, for example AUD');
/** A calendar date (no time, no time zone): YYYY-MM-DD. */
export const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-12-31')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Enter a real date');
const Probability = z.number().int().min(0).max(100);

export const OpportunityStatus = z.enum(['OPEN', 'WON', 'LOST']);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

// ---- pipelines and stages ----------------------------------------------------------------------

export const Pipeline = z
  .object({
    id: Uuid, name: z.string(), isDefault: z.boolean(), position: z.number().int(),
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(), archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Pipeline = z.infer<typeof Pipeline>;

export const Stage = z
  .object({
    id: Uuid, pipelineId: Uuid, name: z.string(), position: z.number().int(), defaultProbability: Probability.nullable(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Stage = z.infer<typeof Stage>;

/** Active pipelines. Empty until the default pipeline is initialised (POST …/sales/pipelines/default). */
export const ListPipelinesResponse = z.object({ pipelines: z.array(Pipeline) }).strict();

const NewStage = z.object({ name: z.string().trim().min(1, 'A stage name is required').max(60), defaultProbability: Probability.nullable().optional() }).strict();
export const CreatePipelineRequest = z
  .object({
    name: z.string().trim().min(1, 'A name is required').max(100),
    /** Optional; a new pipeline gets the standard New, Qualified, Proposal, Negotiation stages otherwise. */
    stages: z.array(NewStage).min(1).max(20).optional(),
  })
  .strict();
export const PipelineResponse = z.object({ pipeline: Pipeline, stages: z.array(Stage) }).strict();

export const ListStagesQuery = z.object({ pipelineId: Uuid.optional() }).strict();
export const ListStagesResponse = z.object({ pipeline: Pipeline, stages: z.array(Stage) }).strict();

// ---- opportunities -----------------------------------------------------------------------------

export const Opportunity = z
  .object({
    id: Uuid,
    title: z.string(),
    customerId: Uuid.nullable(),
    contactId: Uuid.nullable(),
    pipelineId: Uuid,
    stageId: Uuid,
    amount: z.string().nullable(),
    currencyCode: z.string(),
    probability: Probability.nullable(),
    expectedCloseDate: z.string().nullable(),
    ownerUserId: Uuid.nullable(),
    description: z.string().nullable(),
    status: OpportunityStatus,
    lossReason: z.string().nullable(),
    closedAt: z.string().datetime().nullable(),
    /** Increases with every change. PATCH must send the version it was based on. */
    version: z.number().int().min(1),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Opportunity = z.infer<typeof Opportunity>;

const opportunityFields = {
  title: z.string().trim().min(1, 'A title is required').max(200),
  customerId: Uuid.nullable().optional(),
  contactId: Uuid.nullable().optional(),
  amount: Money.nullable().optional(),
  currencyCode: CurrencyCode.optional(),
  probability: Probability.nullable().optional(),
  expectedCloseDate: CalendarDate.nullable().optional(),
  ownerUserId: Uuid.nullable().optional(),
  description: optionalText(5000),
};

/** Pipeline and stage are optional: the default pipeline and its first stage are used. Currency defaults to the business's. */
export const CreateOpportunityRequest = z
  .object({ ...opportunityFields, pipelineId: Uuid.optional(), stageId: Uuid.optional() })
  .strict();
/**
 * Edits details and moves an open opportunity between stages. Changing the pipeline needs a stage of
 * the new pipeline. Status changes go through win, lose and reopen, never through PATCH.
 */
export const UpdateOpportunityRequest = z
  .object({ ...opportunityFields, pipelineId: Uuid, stageId: Uuid })
  .partial()
  .extend({
    /**
     * Optimistic concurrency: the `version` the edit was based on. If someone else changed the
     * opportunity since, the edit is refused (409 stale) instead of silently overwriting theirs.
     */
    version: z.number().int().min(1),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update')
  .refine((v) => v.pipelineId === undefined || v.stageId !== undefined, 'Choose a stage in the new pipeline');

export const LoseOpportunityRequest = z.object({ lossReason: optionalText(500) }).strict();
/** Reopening returns a won or lost opportunity to an open stage (its last stage unless one is given). */
export const ReopenOpportunityRequest = z.object({ stageId: Uuid.optional() }).strict();

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
export const ListOpportunitiesQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(['open', 'won', 'lost', 'all']).default('all'),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    pipelineId: Uuid.optional(),
    stageId: Uuid.optional(),
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
    ownerUserId: Uuid.optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const ListOpportunitiesResponse = z.object({ opportunities: z.array(Opportunity), nextCursor: z.string().nullable() }).strict();
export const OpportunityResponse = z.object({ opportunity: Opportunity }).strict();

/** One time an opportunity was won or lost, kept after it is reopened (docs/sales-data-model.md §4). */
export const OpportunityOutcome = z
  .object({
    id: Uuid,
    status: z.enum(['WON', 'LOST']),
    lossReason: z.string().nullable(),
    stageId: Uuid,
    amount: z.string().nullable(),
    currencyCode: z.string(),
    closedAt: z.string().datetime(),
    closedById: Uuid.nullable(),
    reopenedAt: z.string().datetime().nullable(),
    reopenedById: Uuid.nullable(),
  })
  .strict();
export type OpportunityOutcome = z.infer<typeof OpportunityOutcome>;
export const ListOutcomesResponse = z.object({ outcomes: z.array(OpportunityOutcome) }).strict();
