/**
 * "workflow-ai-build:open" bridge.
 *
 * Sibling of askAiBridge: when the AI workflow generation flow starts, the
 * workflow surface dispatches this event so the outer workspace agent panel
 * opens itself, creates/reuses a session, and prepends the user's initial
 * prompt as the session draft. The publisher lives here (workflow side) so
 * the schema travels with the code that produces it.
 *
 * Why a CustomEvent and not direct props: the agent panel state is owned by
 * WorkspaceScreen, which sits two layers above WorkflowHomePage. Threading a
 * callback prop through every intermediate component would couple them just
 * for this one-way notification. The event keeps the boundary clean.
 */
export const WORKFLOW_AI_BUILD_OPEN_EVENT = 'kition:workflow-ai-build:open'

export interface WorkflowAiBuildOpenPayload {
  /** User's original prompt — what they typed into the AI launcher. */
  prompt: string
  /** The workflow being built. id is the future workflow id (the same value
   *  workflow.created will eventually emit); name is the placeholder name
   *  workflow.generated produces. Both may be empty before the first SSE
   *  event arrives. */
  workflow: { id: string; name: string }
  /** Optional table the workflow is scoped to. Empty for ai-no-context. */
  tableName?: string
}

export function publishWorkflowAiBuildOpen(payload: WorkflowAiBuildOpenPayload): CustomEvent<WorkflowAiBuildOpenPayload> {
  const event = new CustomEvent<WorkflowAiBuildOpenPayload>(WORKFLOW_AI_BUILD_OPEN_EVENT, {
    detail: payload,
    cancelable: true,
  })
  window.dispatchEvent(event)
  return event
}
