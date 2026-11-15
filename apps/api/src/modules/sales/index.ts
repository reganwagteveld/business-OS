// Public API of the sales module (docs/sales-data-model.md). Routes import only from here.
export { createPipeline, initialiseDefaultPipeline, listPipelines, listStages } from './server/pipelines';
export {
  archiveOpportunity, createOpportunity, getOpportunity, listOpportunities, listOutcomes, loseOpportunity, reopenOpportunity, restoreOpportunity,
  updateOpportunity, winOpportunity,
} from './server/opportunities';
// Reporting R1 (docs/reporting-r1.md §4): the Sales Zone's own reporting read model.
export { wonOpportunityDetails, wonOpportunityTotals } from './server/reporting';
export type { SalesPeriodQuery, SalesPeriodRow, WonOpportunityDetail } from './server/reporting';
