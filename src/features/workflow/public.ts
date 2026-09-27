/**
 * Public entry of the workflow feature. Other features import from here,
 * never from the feature's internal modules (enforced by
 * tooling/dependency-cruiser.cjs). Keep this surface small: only what the
 * workspace shell needs to open, route to, and create workflows.
 */
export { openWorkflowRoute, type WorkflowRouteContext } from './lib/openWorkflowRoute'
export { createWorkflowFromMode } from './lib/createWorkflowFromMode'
