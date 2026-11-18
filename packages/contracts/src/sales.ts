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
    /**
     * S-CFG (docs/sales-pipeline-configuration-scfg.md §6.1): the configuration version. Every configuration
     * write names the version it was based on; a change by someone else since then is refused (409 stale).
     */
    configVersion: z.number().int().min(1),
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

// ---- S-CFG-1A: pipeline and stage configuration (docs/sales-pipeline-configuration-scfg.md §6.1) -------------
// Reads need sales:read; every write needs sales:manage (OWNER, ADMIN) and names the pipeline's configVersion.
// Errors: 409 stale (configVersion or stage set changed), name_taken, stage_limit, last_stage,
// has_open_opportunities, archived, not_archived, busy (lock or time limit; nothing was changed);
// 400 invalid_stage.

/** At most 20 active stages per pipeline (D-SCFG-6). */
export const MAX_ACTIVE_STAGES = 20;
/** At most 10 active pipelines per business (D-SCFG-6). */
export const MAX_ACTIVE_PIPELINES = 10;

const StageName = z.string().trim().min(1, 'A stage name is required').max(60);
const ConfigVersion = z.number().int().min(1);

/** A stage as the configuration page shows it: active and archived, with its open-opportunity count. */
export const ConfiguredStage = Stage.extend({ openCount: z.number().int().min(0) }).strict();
export type ConfiguredStage = z.infer<typeof ConfiguredStage>;
/** The pipeline and all its stages: active ones in board order, then archived ones. */
export const PipelineConfigResponse = z.object({ pipeline: Pipeline, stages: z.array(ConfiguredStage) }).strict();
export type PipelineConfigResponse = z.infer<typeof PipelineConfigResponse>;
/** Archive answer: the configuration plus how many open opportunities were moved to the target stage. */
export const ArchiveStageResponse = PipelineConfigResponse.extend({ moved: z.number().int().min(0) }).strict();

export const UpdatePipelineRequest = z.object({ configVersion: ConfigVersion, name: z.string().trim().min(1, 'A name is required').max(100) }).strict();
export const CreateStageRequest = z
  .object({
    configVersion: ConfigVersion,
    name: StageName,
    /** A hint for new opportunities only; never applied to an opportunity by the server (D-SCFG-4). */
    defaultProbability: Probability.nullable().optional(),
    /** Insert after this active stage; at the end when omitted. */
    afterStageId: Uuid.optional(),
  })
  .strict();
export const UpdateStageRequest = z
  .object({ configVersion: ConfigVersion, name: StageName.optional(), defaultProbability: Probability.nullable().optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.defaultProbability !== undefined, 'Nothing to update');
/** The complete new order of the pipeline's active stages. */
export const ReorderStagesRequest = z
  .object({ configVersion: ConfigVersion, stageIds: z.array(Uuid).min(1).max(MAX_ACTIVE_STAGES) })
  .strict()
  .refine((v) => new Set(v.stageIds.map((id) => id.toLowerCase())).size === v.stageIds.length, 'A stage is listed twice');
/** Archiving a stage that holds open opportunities requires a target stage of the same pipeline (D-SCFG-2). */
export const ArchiveStageRequest = z.object({ configVersion: ConfigVersion, moveOpenTo: Uuid.optional() }).strict();
export const RestoreStageRequest = z.object({ configVersion: ConfigVersion }).strict();

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
/**
 * Restore (S-CFG-1A §6.2). Optional body: an archived OPEN opportunity whose stage was archived meanwhile names an
 * active stage of its own pipeline and is restored into it. In an archived pipeline it cannot be restored (409).
 */
export const RestoreOpportunityRequest = z.object({ stageId: Uuid.optional() }).strict().optional();

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

// ---- R2 operational dashboard: the open pipeline as totals -------------------------------------

const SummaryCount = z.number().int().min(0);
/** One currency's open value. `amount` sums priced opportunities only; `count` counts every open one in that currency. */
export const PipelineCurrencyTotal = z.object({ currencyCode: z.string(), amount: z.string(), count: SummaryCount }).strict();
export type PipelineCurrencyTotal = z.infer<typeof PipelineCurrencyTotal>;
export const PipelineStageSummary = z
  .object({ id: Uuid, name: z.string(), position: z.number().int(), archived: z.boolean(), count: SummaryCount, totals: z.array(PipelineCurrencyTotal) })
  .strict();
export const PipelineSummary = z
  .object({ id: Uuid, name: z.string(), isDefault: z.boolean(), count: SummaryCount, totals: z.array(PipelineCurrencyTotal), stages: z.array(PipelineStageSummary) })
  .strict();
/**
 * Open, not archived opportunities grouped by pipeline, stage and currency (one grouped query). Amounts are
 * per currency, never converted or added across currencies. Archived pipelines are left out unless they still
 * hold open opportunities; archived stages appear only while they hold some (marked `archived`).
 */
export const SalesSummary = z
  .object({ open: z.object({ count: SummaryCount, totals: z.array(PipelineCurrencyTotal) }).strict(), pipelines: z.array(PipelineSummary) })
  .strict();
export type SalesSummary = z.infer<typeof SalesSummary>;
export const SalesSummaryResponse = z.object({ summary: SalesSummary }).strict();
