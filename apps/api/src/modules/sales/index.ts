// Public API of the sales module (docs/sales-data-model.md). Routes import only from here.
export { createPipeline, initialiseDefaultPipeline, listPipelines, listStages } from './server/pipelines';
// S-CFG-1A (docs/sales-pipeline-configuration-scfg.md §6.1): pipeline and stage configuration.
export {
  archiveStage, CONFIG_ROUTE_TIMEOUT_MS, createStage, getPipelineConfig, reorderStages, restoreStage, setConfigTestHooks, updatePipeline, updateStage,
} from './server/configuration';
export type { ConfigTestHooks } from './server/configuration';
export {
  archiveOpportunity, createOpportunity, getOpportunity, listOpportunities, listOutcomes, loseOpportunity, reopenOpportunity, restoreOpportunity,
  updateOpportunity, winOpportunity,
} from './server/opportunities';
// Reporting R1 (docs/reporting-r1.md §4): the Sales Zone's own reporting read model.
export { wonOpportunityDetails, wonOpportunityTotals } from './server/reporting';
export type { SalesPeriodQuery, SalesPeriodRow, WonOpportunityDetail } from './server/reporting';
// R2 operational dashboard (docs/dashboard-r2.md §3): the open pipeline as grouped totals.
export { salesSummary } from './server/summary';
// Global search GS1-A (docs/global-search-gs1.md §6.2).
export { opportunitySearchProvider, SALES_SEARCH_INDEXES } from './server/search';
