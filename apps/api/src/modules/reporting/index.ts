// Public API of the reporting module (docs/reporting-r1.md). Routes import only from here. Reporting owns
// the metric registry, the query engine and saved-view configurations. It owns no business data: every
// metric is computed by the owning Zone's own reporting read model, called through that Zone's public API.
export { catalog, runDetails, runQuery } from './server/engine';
export type { ParsedQuery } from './server/engine';
export { createView, deleteView, getView, listViews, MAX_VIEWS_PER_OWNER, runView, updateView } from './server/views';
export type { ReportingActor } from './server/views';
export { METRICS } from './server/registry';
export type { MetricDefinition, MetricId } from './server/registry';
