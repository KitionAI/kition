// WorkflowRouteContext describes a pre-selected table the editor should
// open against. When the caller has resolved a table (e.g. table right-click
// → "create workflow here"), it passes a fully-populated context. As of
// the "delayed table binding" refactor, callers that want to create an
// unbound workflow pass `null` to openWorkflowRoute instead — the
// editor then opens with an empty trigger and the user picks the table
// inside the trigger config panel (or asks the AI to bind it).
export type WorkflowRouteContext = {
  documentId: string
  tableId: string
  tableName: string
}

export type OpenWorkflowHomeOptions = {
  /** Pre-select this workflow in the Home list. Used by the Build page's
   *  "Open in Workflows" handoff so the user lands directly on the
   *  workflow they were just viewing. */
  workflowId?: string
}

export function openWorkflowHome(options: OpenWorkflowHomeOptions = {}) {
  const { workflowContext: _workflowContext, selectedWorkflowId: _prevSelected, ...rest } = window.history.state || {}
  const next = options.workflowId
    ? { ...rest, selectedWorkflowId: options.workflowId }
    : rest
  window.history.pushState(next, '', '/workflow')
  window.dispatchEvent(new PopStateEvent('popstate', { state: next }))
}

export function openWorkflowDetail(workflowId: string) {
  const state = { ...(window.history.state || {}) }
  window.history.pushState(state, '', `/workflow/${workflowId}`)
  window.dispatchEvent(new PopStateEvent('popstate', { state }))
}

export function openWorkflowRoute(
  context: WorkflowRouteContext | null,
  options: { mode?: 'ai' | 'editor' } = {},
) {
  const mode = options.mode ?? 'editor'
  const state = {
    ...(window.history.state || {}),
    // Persist null explicitly so a previous context doesn't leak into the
    // unbound-creation path via window.history.state inheritance.
    workflowContext: context,
    workflowMode: mode,
  }
  // Encode the mode in the URL too so e2e tests can assert routing
  // independently of in-memory state. AI mode opens the chat-first surface;
  // editor mode (default) lands on the canvas as before.
  const url = mode === 'ai' ? '/workflow/new?mode=ai' : '/workflow/new'
  window.history.pushState(state, '', url)
  window.dispatchEvent(new PopStateEvent('popstate', { state }))
}
