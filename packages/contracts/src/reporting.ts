import { z } from 'zod';

// Reporting R1 (docs/reporting-r1.md). Every path is under /api/v1/b/:slug, so no request carries a
// business id. Clients name REGISTERED metrics by stable id and version; they never send SQL, table or
// column names, expressions or sort keys outside the allowlists below, and every body is strict, so an
// unknown field is rejected rather than ignored. Amounts are exact decimal strings and are never added
// across currencies.

const Uuid = z.string().uuid();
const Instant = z.string().datetime();
const Version = z.number().int().min(1);

/** A calendar date (YYYY-MM-DD) in the business's time zone. Real dates only, years 2000-2099. */
export const ReportingDate = z
  .string()
  .regex(/^20\d{2}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-30')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Enter a real date');

/** Stable metric identifier: `<zone>.<name>`, lower snake case. */
export const MetricId = z.string().max(80).regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'Unknown metric');
export const MetricRef = z.object({ id: MetricId, version: z.number().int().min(1).max(999) }).strict();
export type MetricRef = z.infer<typeof MetricRef>;

export const ReportingZone = z.enum(['finance', 'sales', 'customers', 'projects', 'scheduling', 'people', 'communications']);
export const ReportingGranularity = z.enum(['day', 'week', 'month', 'none']);
export type ReportingGranularity = z.infer<typeof ReportingGranularity>;
export const ReportingDimension = z.enum(['currency', 'customer']);
export type ReportingDimension = z.infer<typeof ReportingDimension>;
export const ReportingFilterKey = z.enum(['currencyCode', 'customerId']);
export const ReportingComparison = z.enum(['none', 'previous_period']);
export const ReportingDatePreset = z.enum([
  'last_7_days', 'last_30_days', 'last_90_days', 'this_month', 'last_month', 'last_3_months', 'last_12_months', 'year_to_date',
]);
export type ReportingDatePreset = z.infer<typeof ReportingDatePreset>;

/**
 * Which dates a report covers: an explicit inclusive range, or a preset resolved on the server against
 * "today" in the business's time zone at every run (so a saved "last 30 days" stays current).
 */
export const ReportingDateConfig = z.union([
  z.object({ kind: z.literal('fixed'), from: ReportingDate, to: ReportingDate }).strict(),
  z.object({ kind: z.literal('relative'), preset: ReportingDatePreset }).strict(),
]);
export type ReportingDateConfig = z.infer<typeof ReportingDateConfig>;

export const ReportingFilters = z
  .object({
    currencyCode: z.string().regex(/^[A-Z]{3}$/, 'Use an ISO 4217 code such as AUD').optional(),
    customerId: Uuid.optional(),
  })
  .strict();
export type ReportingFilters = z.infer<typeof ReportingFilters>;

/** POST /reporting/query: run up to six registered metrics over one date range. */
export const ReportingQueryRequest = z
  .object({
    metrics: z.array(MetricRef).min(1, 'Choose at least one metric').max(6, 'At most six metrics per report'),
    date: ReportingDateConfig,
    granularity: ReportingGranularity.default('month'),
    groupBy: ReportingDimension.nullable().default(null),
    filters: ReportingFilters.default({}),
    comparison: ReportingComparison.default('none'),
  })
  .strict();
export type ReportingQueryRequest = z.input<typeof ReportingQueryRequest>;

// ---- registry (catalogue) ------------------------------------------------------------------------

export const ReportingMetricDefinition = z
  .object({
    id: MetricId,
    version: Version,
    name: z.string(),
    description: z.string(),
    /** The Zone whose own records and rules are the authoritative source. */
    zone: ReportingZone,
    valueType: z.enum(['money', 'count']),
    /** How to label the value: "per currency" for money, or a noun such as "invoices". */
    unit: z.string(),
    /** `period`: summed over the date range (time series possible). `snapshot`: the current value as of today. */
    temporal: z.enum(['period', 'snapshot']),
    /** Plain-language calculation rules (what is counted, what is excluded). */
    semantics: z.string(),
    /** Which date places a record in a period, and in which zone that date is read. */
    dateField: z.string(),
    timeZone: z.string(),
    /** How draft, void, cancelled, reversed and archived records are treated. */
    statusTreatment: z.string(),
    granularities: z.array(ReportingGranularity),
    dimensions: z.array(ReportingDimension),
    filters: z.array(ReportingFilterKey),
    /** Every API permission key this metric needs, besides reporting:read. */
    requires: z.array(z.string()),
    /** Extra keys a grouping dimension needs (for example customer names need customers:read). */
    dimensionRequires: z.record(z.string(), z.array(z.string())),
    tenantScope: z.literal('business'),
    availability: z.enum(['available', 'planned']),
    /** Why a planned metric is not available yet, and what it waits for. */
    plannedNote: z.string().nullable(),
    /** Whether the caller holds every key in `requires` (presentation only; the API checks on every run). */
    accessible: z.boolean(),
    hasDetail: z.boolean(),
    defaultChart: z.enum(['line', 'bar', 'kpi']),
    /** Groups smaller than this are suppressed (k-anonymity); null when not needed. */
    minimumGroupSize: z.number().int().nullable(),
  })
  .strict();
export type ReportingMetricDefinition = z.infer<typeof ReportingMetricDefinition>;

export const ReportingLimits = z
  .object({ maxMetrics: z.number().int(), maxRangeDays: z.number().int(), maxBuckets: z.number().int(), maxSeries: z.number().int(), maxDetailRows: z.number().int() })
  .strict();

export const ReportingCatalogResponse = z
  .object({ timeZone: z.string(), today: ReportingDate, metrics: z.array(ReportingMetricDefinition), limits: ReportingLimits })
  .strict();
export type ReportingCatalog = z.infer<typeof ReportingCatalogResponse>;

// ---- results -------------------------------------------------------------------------------------

export const ReportingRange = z.object({ from: ReportingDate, to: ReportingDate }).strict();
export type ReportingRange = z.infer<typeof ReportingRange>;

/** One bucket of a series. `value` is null when the bucket is suppressed (small group). */
export const ReportingPoint = z.object({ bucket: ReportingDate, value: z.string().nullable() }).strict();
export type ReportingPoint = z.infer<typeof ReportingPoint>;

export const ReportingSeries = z
  .object({
    key: z.string(),
    label: z.string(),
    /** Money series always carry exactly one currency; count series carry none unless grouped by currency. */
    currencyCode: z.string().nullable(),
    customerId: Uuid.nullable(),
    total: z.string().nullable(),
    comparisonTotal: z.string().nullable(),
    /** Change against the comparison period in percent, one decimal; null without comparison or from zero. */
    changePercent: z.string().nullable(),
    points: z.array(ReportingPoint),
    /** Aligned with `points` by position (bucket n of the previous period); shorter when the previous period has fewer buckets. */
    comparisonPoints: z.array(ReportingPoint).nullable(),
    suppressed: z.boolean(),
  })
  .strict();
export type ReportingSeries = z.infer<typeof ReportingSeries>;

export const ReportingMetricResult = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      metric: MetricRef,
      name: z.string(),
      valueType: z.enum(['money', 'count']),
      unit: z.string(),
      temporal: z.enum(['period', 'snapshot']),
      granularity: ReportingGranularity,
      groupBy: ReportingDimension.nullable(),
      /** Bucket start dates in order (empty for snapshots and for granularity `none` it holds one entry). */
      buckets: z.array(ReportingDate),
      series: z.array(ReportingSeries),
      /** Series left out beyond the limit (smallest first). */
      hiddenSeries: z.number().int().min(0),
      /** Snapshots: the business-local date the value is as of. */
      asOf: ReportingDate.nullable(),
      notes: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      /** The metric could not run for this caller or this configuration. Nothing about its data is returned. */
      status: z.literal('error'),
      metric: MetricRef,
      name: z.string().nullable(),
      code: z.string(),
      message: z.string(),
    })
    .strict(),
]);
export type ReportingMetricResult = z.infer<typeof ReportingMetricResult>;

export const ReportingQueryResponse = z
  .object({
    timeZone: z.string(),
    range: ReportingRange,
    comparisonRange: ReportingRange.nullable(),
    results: z.array(ReportingMetricResult),
  })
  .strict();
export type ReportingQueryResult = z.infer<typeof ReportingQueryResponse>;

// ---- drill-down ----------------------------------------------------------------------------------

export const ReportingDetailsRequest = z
  .object({
    metric: MetricRef,
    date: ReportingDateConfig,
    filters: ReportingFilters.default({}),
    cursor: z.string().min(1).max(600).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ReportingDetailsRequest = z.input<typeof ReportingDetailsRequest>;

export const ReportingColumn = z
  .object({ key: z.string(), label: z.string(), type: z.enum(['text', 'date', 'datetime', 'money', 'status']) })
  .strict();
export const ReportingDetailRow = z
  .object({ id: Uuid, currencyCode: z.string().nullable(), cells: z.record(z.string(), z.string().nullable()) })
  .strict();
export type ReportingDetailRow = z.infer<typeof ReportingDetailRow>;

export const ReportingDetailsResponse = z
  .object({
    metric: MetricRef,
    range: ReportingRange,
    columns: z.array(ReportingColumn),
    rows: z.array(ReportingDetailRow),
    /** Newest first, then by id: a stable order, so pages never repeat or skip rows. */
    nextCursor: z.string().nullable(),
  })
  .strict();
export type ReportingDetails = z.infer<typeof ReportingDetailsResponse>;

// ---- saved views ---------------------------------------------------------------------------------

export const SavedViewVisibility = z.enum(['PRIVATE', 'BUSINESS']);
export type SavedViewVisibility = z.infer<typeof SavedViewVisibility>;
export const SavedViewReportType = z.enum(['metrics']);

/** Config format version written by this client and API. Older formats are migrated or refused on read. */
export const SAVED_VIEW_CONFIG_VERSION = 1 as const;

export const SavedViewConfig = z
  .object({
    metrics: z.array(MetricRef).min(1, 'Choose at least one metric').max(6, 'At most six metrics per report'),
    date: ReportingDateConfig,
    granularity: ReportingGranularity,
    groupBy: ReportingDimension.nullable(),
    filters: ReportingFilters,
    comparison: ReportingComparison,
    sort: z.object({ by: z.enum(['bucket', 'value']), direction: z.enum(['asc', 'desc']) }).strict(),
    visualization: z.object({ chart: z.enum(['line', 'bar', 'table']), showComparison: z.boolean() }).strict(),
  })
  .strict();
export type SavedViewConfig = z.infer<typeof SavedViewConfig>;

const title = z.string().trim().min(1, 'A title is required').max(120, 'At most 120 characters');
const description = z.string().trim().max(1000, 'At most 1000 characters').transform((v) => (v === '' ? null : v)).nullable();

export const SavedView = z
  .object({
    id: Uuid,
    title: z.string(),
    description: z.string().nullable(),
    reportType: SavedViewReportType,
    config: SavedViewConfig,
    configVersion: Version,
    visibility: SavedViewVisibility,
    ownerUserId: Uuid,
    isOwner: z.boolean(),
    version: Version,
    createdAt: Instant,
    updatedAt: Instant,
  })
  .strict();
export type SavedView = z.infer<typeof SavedView>;

export const SavedViewListItem = SavedView.omit({ config: true })
  .extend({
    metrics: z.array(MetricRef),
    /** Problems found against the current registry (for example a retired metric). Empty when it runs as saved. */
    issues: z.array(z.string()),
  })
  .strict();
export type SavedViewListItem = z.infer<typeof SavedViewListItem>;

export const CreateSavedViewRequest = z
  .object({
    title,
    description: description.optional(),
    reportType: SavedViewReportType.default('metrics'),
    /** Private unless explicitly shared; sharing needs reporting:share. */
    visibility: SavedViewVisibility.default('PRIVATE'),
    config: SavedViewConfig,
  })
  .strict();
export type CreateSavedViewRequest = z.input<typeof CreateSavedViewRequest>;

export const UpdateSavedViewRequest = z
  .object({
    version: Version,
    title: title.optional(),
    description: description.optional(),
    visibility: SavedViewVisibility.optional(),
    config: SavedViewConfig.optional(),
  })
  .strict();
export type UpdateSavedViewRequest = z.input<typeof UpdateSavedViewRequest>;

export const ListSavedViewsQuery = z
  .object({ scope: z.enum(['all', 'mine', 'shared']).default('all') })
  .strict();

export const SavedViewResponse = z.object({ view: SavedView }).strict();
export const ListSavedViewsResponse = z.object({ views: z.array(SavedViewListItem) }).strict();
export const DeleteSavedViewResponse = z.object({ ok: z.literal(true) }).strict();

/** Running a saved view: its stored configuration, validated against the current registry, as the caller. */
export const RunSavedViewResponse = z.object({ view: SavedView, result: ReportingQueryResponse }).strict();

/**
 * Error codes of the reporting endpoints, besides the shared ones (400 invalid_input / invalid_query,
 * 401, 403 forbidden, 404 not_found). Registry and range problems answer 400 with { error, message }.
 */
export const REPORTING_ERROR_CODES = [
  'unknown_metric', 'metric_unavailable', 'metric_version_unsupported', 'unsupported_granularity', 'unsupported_dimension', 'unsupported_filter',
  'invalid_date_range', 'range_too_large', 'too_many_buckets', 'no_detail', 'invalid_cursor', 'forbidden_source', 'stale', 'too_many_views',
  'view_config_invalid',
] as const;
