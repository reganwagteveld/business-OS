// The reporting registry (docs/reporting-r1.md §3): every metric the API will run, defined in code with a
// stable id and version. Clients name metrics by id; there is no other way to ask for data, so no client
// can send SQL, a table, a column or an expression. Each available metric is bound to one source in
// ./sources.ts, which calls the owning Zone's own reporting read model through that Zone's public API.
//
// Versioning: `version` changes whenever the meaning of a metric changes (what is counted, which date).
// A saved view stores {id, version}; `compatible` lists the stored versions that still mean the same
// thing. Anything else is refused with metric_version_unsupported, never silently reinterpreted.
import type { Permission } from '@/modules/access';
import type { ReportingDimension, ReportingGranularity } from '@business-os/contracts';

export type MetricId =
  | 'finance.invoiced_amount' | 'finance.credited_amount' | 'finance.payments_received' | 'finance.receivables_outstanding' | 'finance.receivables_overdue'
  | 'finance.invoices_issued' | 'sales.won_value' | 'sales.won_count' | 'customers.new_customers'
  | 'finance.expenses_recorded' | 'projects.tasks_completed' | 'scheduling.events_scheduled' | 'people.headcount' | 'communications.messages_recorded';

export type SourceKey =
  | 'finance.invoices' | 'finance.credit_notes' | 'finance.payments_received' | 'finance.receivables_outstanding' | 'finance.receivables_overdue'
  | 'sales.won' | 'customers.new';

export interface MetricDefinition {
  id: MetricId;
  version: number;
  /** Stored versions that still mean exactly this metric. Always includes `version`. */
  compatible: readonly number[];
  name: string;
  description: string;
  zone: 'finance' | 'sales' | 'customers' | 'projects' | 'scheduling' | 'people' | 'communications';
  valueType: 'money' | 'count';
  unit: string;
  temporal: 'period' | 'snapshot';
  semantics: string;
  dateField: string;
  timeZone: string;
  statusTreatment: string;
  granularities: readonly ReportingGranularity[];
  dimensions: readonly ReportingDimension[];
  filters: readonly ('currencyCode' | 'customerId')[];
  /** Source permissions (besides reporting:read). Access = reporting:read ∩ all of these ∩ the business in the URL. */
  requires: readonly Permission[];
  /** Extra keys per grouping dimension (customer names belong to the Customers Zone). */
  dimensionRequires: Partial<Record<ReportingDimension, readonly Permission[]>>;
  availability: 'available' | 'planned';
  plannedNote: string | null;
  /** The bound source, for available metrics. */
  source: SourceKey | null;
  /** Which value of the source rows this metric reports: the summed amount (money) or the number of records (count). */
  value: 'amount' | 'count';
  hasDetail: boolean;
  defaultChart: 'line' | 'bar' | 'kpi';
  /**
   * Groups (and buckets) whose record count is below this are suppressed: value null, `suppressed`. For
   * any metric whose small groups could disclose something about one person. Null when not needed.
   */
  minimumGroupSize: number | null;
}

const PERIODS = ['day', 'week', 'month', 'none'] as const;
const BUSINESS_DATE = 'Business time zone (from the business settings)';
const PLANNED = { availability: 'planned', source: null, granularities: [], dimensions: [], filters: [], dimensionRequires: {}, hasDetail: false } as const;

export const METRICS: readonly MetricDefinition[] = [
  {
    id: 'finance.invoiced_amount', version: 1, compatible: [1], name: 'Amount invoiced', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'Total of the invoices you issued in the period, per currency.',
    semantics: 'Sum of the total (tax included, after line discounts) of issued invoices. This is what you billed, not recognised revenue and not money received. Credit notes are not subtracted (see Amount credited). Currencies are never converted or added together.',
    temporal: 'period', dateField: 'Invoice issue date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Issued invoices only. Drafts are not counted. Voided invoices are removed from every period, including the one they were issued in.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['finance:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'finance.invoices', value: 'amount', hasDetail: true, defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    id: 'finance.invoices_issued', version: 1, compatible: [1], name: 'Invoices issued', zone: 'finance', valueType: 'count', unit: 'invoices',
    description: 'How many invoices you issued in the period.',
    semantics: 'Number of issued invoices, in any currency.',
    temporal: 'period', dateField: 'Invoice issue date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Issued invoices only. Drafts are not counted. Voided invoices are removed from every period.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['finance:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'finance.invoices', value: 'count', hasDetail: true, defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    id: 'finance.credited_amount', version: 1, compatible: [1], name: 'Amount credited', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'Total of the credit notes you issued in the period, per currency.',
    semantics: 'Sum of the total (tax included) of issued credit notes. Reported beside Amount invoiced, never netted against it. Issuing a credit note does not refund money.',
    temporal: 'period', dateField: 'Credit note issue date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Issued credit notes only. Drafts are not counted. Voided credit notes are removed from every period.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['finance:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'finance.credit_notes', value: 'amount', hasDetail: true, defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    id: 'finance.payments_received', version: 1, compatible: [1], name: 'Amount received', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'Money you recorded as received from customers in the period, per currency.',
    semantics: 'Sum of recorded payments received from customers, whether or not they are allocated to an invoice yet. Payments made to suppliers are not included.',
    temporal: 'period', dateField: 'Date the payment was received', timeZone: BUSINESS_DATE,
    statusTreatment: 'Recorded payments only. Reversed payments are removed from every period, including the one they were received in.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['finance:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'finance.payments_received', value: 'amount', hasDetail: true, defaultChart: 'line', minimumGroupSize: null,
  },
  {
    id: 'finance.receivables_outstanding', version: 1, compatible: [1], name: 'Outstanding receivables', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'What customers still owe on issued invoices today, per currency.',
    semantics: 'For each issued invoice: total minus allocated payments minus applied credit, summed per currency. The same calculation as the Finance overview. Unallocated payments and unapplied credit are not netted against it.',
    temporal: 'snapshot', dateField: 'Today (current balance; not available for past dates in R1)', timeZone: BUSINESS_DATE,
    statusTreatment: 'Issued invoices only. Drafts and voided invoices owe nothing.',
    granularities: ['none'], dimensions: ['currency'], filters: ['currencyCode'],
    requires: ['finance:read'], dimensionRequires: {},
    availability: 'available', plannedNote: null, source: 'finance.receivables_outstanding', value: 'amount', hasDetail: false, defaultChart: 'kpi', minimumGroupSize: null,
  },
  {
    id: 'finance.receivables_overdue', version: 1, compatible: [1], name: 'Overdue receivables', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'The part of outstanding receivables that is past its due date today, per currency.',
    semantics: 'Outstanding amount of issued invoices whose due date is before today in the business time zone. The same calculation as the Finance overview.',
    temporal: 'snapshot', dateField: 'Today (current balance; not available for past dates in R1)', timeZone: BUSINESS_DATE,
    statusTreatment: 'Issued invoices only. Drafts and voided invoices owe nothing.',
    granularities: ['none'], dimensions: ['currency'], filters: ['currencyCode'],
    requires: ['finance:read'], dimensionRequires: {},
    availability: 'available', plannedNote: null, source: 'finance.receivables_overdue', value: 'amount', hasDetail: false, defaultChart: 'kpi', minimumGroupSize: null,
  },
  {
    id: 'sales.won_value', version: 1, compatible: [1], name: 'Won opportunity value', zone: 'sales', valueType: 'money', unit: 'per currency',
    description: 'Value of the opportunities you won in the period, per currency.',
    semantics: 'Sum of the amount of opportunities that are currently won. Opportunities without an amount add nothing (they are still counted in Opportunities won). A sales outcome: not invoiced and not received money.',
    temporal: 'period', dateField: 'Date the opportunity was won', timeZone: BUSINESS_DATE,
    statusTreatment: 'Won opportunities only. Open and lost ones are not counted. A reopened opportunity leaves every period until it is won again. Archived opportunities are not counted.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['sales:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'sales.won', value: 'amount', hasDetail: true, defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    id: 'sales.won_count', version: 1, compatible: [1], name: 'Opportunities won', zone: 'sales', valueType: 'count', unit: 'opportunities',
    description: 'How many opportunities you won in the period.',
    semantics: 'Number of opportunities that are currently won, with or without an amount, in any currency.',
    temporal: 'period', dateField: 'Date the opportunity was won', timeZone: BUSINESS_DATE,
    statusTreatment: 'Won opportunities only. A reopened opportunity leaves every period until it is won again. Archived opportunities are not counted.',
    granularities: PERIODS, dimensions: ['currency', 'customer'], filters: ['currencyCode', 'customerId'],
    requires: ['sales:read'], dimensionRequires: { customer: ['customers:read'] },
    availability: 'available', plannedNote: null, source: 'sales.won', value: 'count', hasDetail: true, defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    id: 'customers.new_customers', version: 1, compatible: [1], name: 'New customers', zone: 'customers', valueType: 'count', unit: 'customers',
    description: 'How many customers were added in the period.',
    semantics: 'Number of customers created in the period.',
    temporal: 'period', dateField: 'Date the customer was created', timeZone: BUSINESS_DATE,
    statusTreatment: 'Archived customers are not counted, in any period.',
    granularities: PERIODS, dimensions: [], filters: [],
    requires: ['customers:read'], dimensionRequires: {},
    availability: 'available', plannedNote: null, source: 'customers.new', value: 'count', hasDetail: true, defaultChart: 'line', minimumGroupSize: null,
  },
  // ---- planned: registered so saved views and the UI can name them, never executable -------------------
  {
    ...PLANNED, id: 'finance.expenses_recorded', version: 1, compatible: [1], name: 'Expenses recorded', zone: 'finance', valueType: 'money', unit: 'per currency',
    description: 'Total of expenses recorded in the period, per currency.', semantics: 'Planned.', temporal: 'period', dateField: 'Expense date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Planned: recorded expenses only; drafts and voided expenses excluded.', requires: ['finance:read'],
    plannedNote: 'Needs a Finance-owned expense read model (finance/server/reporting.ts) with the F3 tax treatment rules. Not built in R1.',
    value: 'amount', defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    ...PLANNED, id: 'projects.tasks_completed', version: 1, compatible: [1], name: 'Tasks completed', zone: 'projects', valueType: 'count', unit: 'tasks',
    description: 'How many project tasks were completed in the period.', semantics: 'Planned.', temporal: 'period', dateField: 'Task completion date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Planned.', requires: ['projects:read'],
    plannedNote: 'Projects has no completion timestamp on tasks yet (only the current column). Needs a Projects change first.',
    value: 'count', defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    ...PLANNED, id: 'scheduling.events_scheduled', version: 1, compatible: [1], name: 'Events scheduled', zone: 'scheduling', valueType: 'count', unit: 'events',
    description: 'How many events take place in the period.', semantics: 'Planned.', temporal: 'period', dateField: 'Event start', timeZone: BUSINESS_DATE,
    statusTreatment: 'Planned: cancelled and archived events excluded.', requires: ['scheduling:read'],
    plannedNote: 'Needs a Scheduling-owned read model that respects ADR 0006 privacy (busy-only details).',
    value: 'count', defaultChart: 'bar', minimumGroupSize: null,
  },
  {
    ...PLANNED, id: 'people.headcount', version: 1, compatible: [1], name: 'Headcount', zone: 'people', valueType: 'count', unit: 'employees',
    description: 'Active employees on a date.', semantics: 'Planned.', temporal: 'snapshot', dateField: 'Employment status history', timeZone: BUSINESS_DATE,
    statusTreatment: 'Planned: active employees only.', requires: ['people:read'],
    plannedNote: 'Needs a People-owned read model using directory (work) fields only, never people:read_sensitive data, with groups under 5 suppressed.',
    value: 'count', defaultChart: 'kpi', minimumGroupSize: 5,
  },
  {
    ...PLANNED, id: 'communications.messages_recorded', version: 1, compatible: [1], name: 'Messages recorded', zone: 'communications', valueType: 'count', unit: 'messages',
    description: 'How many customer messages were recorded in the period.', semantics: 'Planned.', temporal: 'period', dateField: 'Message date', timeZone: BUSINESS_DATE,
    statusTreatment: 'Planned.', requires: ['communications:read'],
    plannedNote: 'Needs a Communications-owned read model. Restricted notes are enforced in the activity service, not RLS, so any activity-based metric must go through that service.',
    value: 'count', defaultChart: 'bar', minimumGroupSize: null,
  },
];

const BY_ID = new Map<string, MetricDefinition>(METRICS.map((m) => [m.id, m]));
export const metricById = (id: string): MetricDefinition | undefined => BY_ID.get(id);
