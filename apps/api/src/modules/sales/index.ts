// Public API of the sales module (docs/sales-data-model.md). Routes import only from here.
export { createPipeline, ensureDefaultPipeline, listPipelines, listStages } from './server/pipelines';
export {
  archiveOpportunity, createOpportunity, getOpportunity, listOpportunities, loseOpportunity, reopenOpportunity, restoreOpportunity,
  updateOpportunity, winOpportunity,
} from './server/opportunities';
