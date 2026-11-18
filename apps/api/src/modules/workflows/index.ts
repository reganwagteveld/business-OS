// Public API of the workflows module (docs/cross-zone-workflows-wf1.md §4.1, W1-D1; LC-1 = WF-1B-2).
// A thin orchestration layer: it owns no business records. It checks another Zone's record under the
// locks of §6.10, then asks the Projects Zone (through its index) to write the project. Routes import only from here.
export { linkProjectOpportunity, linkProjectQuote, projectFromOpportunity, projectFromQuote, workflowIdempotencyKey } from './server/projects';
