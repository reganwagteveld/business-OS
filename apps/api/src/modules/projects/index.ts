// Public API of the projects module (docs/projects-data-model.md). Routes import only from here.
export {
  archiveProject, createProject, getProject, listCustomerProjects, listProjects, projectSummary, restoreProject, updateProject, viewerOf,
} from './server/projects';
export type { Viewer } from './server/projects';
// WF-1 links (docs/cross-zone-workflows-wf1.md §6.2–6.4, LC-1): the Projects side, called by the workflows module.
export { countOpportunityProjects, projectLinks, setProjectOpportunity, setProjectQuote } from './server/projects';
export type { ProjectLinks, ProjectSources } from './server/projects';
export { archiveTask, createTask, listTasks, moveTask, restoreTask, updateTask } from './server/tasks';
// Global search GS1-A (docs/global-search-gs1.md §6.2).
export { projectSearchProvider, PROJECTS_SEARCH_INDEXES, taskSearchProvider } from './server/search';
// Reporting WP-R1 (docs/reporting-operational-r1.md): the Projects Zone's own reporting read model.
export { completedTaskCounts, completedTaskDetails } from './server/reporting';
export type { CompletedTaskDetail, TaskPeriodQuery, TaskPeriodRow } from './server/reporting';
