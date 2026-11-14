// Public API of the sales module (docs/sales-data-model.md). Routes import only from here.
export { createPipeline, initialiseDefaultPipeline, listPipelines, listStages } from './server/pipelines';
export {
  archiveOpportunity, createOpportunity, getOpportunity, listOpportunities, listOutcomes, loseOpportunity, reopenOpportunity, restoreOpportunity,
  updateOpportunity, winOpportunity,
} from './server/opportunities';
