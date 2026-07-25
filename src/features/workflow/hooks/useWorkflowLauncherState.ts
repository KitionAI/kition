import { useCallback, useState } from 'react'

import { createWorkflow } from '@/features/workflow/api'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import type { WorkflowTemplate } from '@/features/workflow/templates'

/**
 * useWorkflowLauncherState — owns the launcher's three state slots
 * (busy action / busy template id / error) plus the three create flows
 * (scratch, template, agent) the launcher fans out into.
 *
 * Extracted from WorkflowHomePage (WF-C1h). Two cross-page effects flow
 * through the dependency bag:
 *
 *   * `refresh` re-fetches the workflow list after a create so the new
 *     row shows up in the rail.
 *   * `onCreated` lets the page select the freshly-created workflow
 *     (typically `setSelectedId`) without coupling this hook to the
 *     full list state.
 *
 * The agent flow ("Open the assistant panel") dispatches a window
 * CustomEvent with no associated state, so it lives here too for
 * symmetry — surrounding code can wire one `useWorkflowLauncherState`
 * result instead of juggling the event listener manually.
 */
export interface UseWorkflowLauncherStateResult {
  busyAction: 'ai' | 'scratch' | 'template' | null
  busyTemplateId: string | undefined
  error: string | null
  /** Wipe the error toast. Called by surrounding flows (the create-mode
   *  dialog's onBeforeOpen) that want to take over the create surface
   *  with a clean slate. */
  clearError: () => void
  /** Run the "Start from scratch" path. Awaits the createWorkflow call,
   *  refreshes the list, and reports the new id via onCreated. */
  runScratch: () => Promise<void>
  /** Run the "From template" path. Threads the template through
   *  createWorkflowFromTemplate first, and forwards the unresolved
   *  field-name list into sessionStorage so the post-creation page
   *  banner has the handoff payload (see WF-U4). */
  runTemplate: (template: WorkflowTemplate) => Promise<void>
  /** Fire the assistant-panel open event. No state changes. */
  handleAgent: () => void
}

export interface UseWorkflowLauncherStateDeps {
  /** Re-fetch the workflow list. Called after every successful create
   *  so the new row appears in the rail before the page selects it. */
  refresh: () => Promise<void>
  /** Called with the new workflow id after a successful create so the
   *  page can update its selection state. */
  onCreated: (id: string) => void
}

export function useWorkflowLauncherState(deps: UseWorkflowLauncherStateDeps): UseWorkflowLauncherStateResult {
  const [busyAction, setBusyAction] = useState<'ai' | 'scratch' | 'template' | null>(null)
  const [busyTemplateId, setBusyTemplateId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const clearError = useCallback(() => setError(null), [])

  const runScratch = useCallback(async () => {
    setBusyAction('scratch')
    try {
      // Draft workflow with delayed table binding: documentId/tableId stay
      // empty so the user picks the table from the trigger panel. The
      // trigger type is seeded as record_created — the drawer's event
      // dropdown shows record_created as its default anyway, and leaving
      // the type empty meant the value the user saw wasn't actually
      // written (the dropdown's "pick the displayed default" change was a
      // no-op against `'' || 'record_created'`). Seeding it here keeps
      // the drawer display and the persisted draft in lockstep.
      const def = await createWorkflow({
        name: 'Untitled workflow',
        description: '',
        enabled: false,
        trigger: { type: 'record_created', documentId: '', tableId: '' },
        action: {
          type: 'send_email',
          connectionId: '',
          to: 'you@example.com',
          subject: { parts: [{ kind: 'text', text: 'New record' }] },
          body: { parts: [{ kind: 'text', text: 'A new record was created.' }] },
        },
      })
      await deps.refresh()
      deps.onCreated(def.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow')
    } finally {
      setBusyAction(null)
    }
  }, [deps])

  const runTemplate = useCallback(async (template: WorkflowTemplate) => {
    setBusyAction('template')
    setBusyTemplateId(template.id)
    try {
      // No schema yet — template body parts fall back to literal
      // placeholders; the user binds a table from the trigger config
      // panel and the placeholders resolve at that point.
      const { input, unresolvedFieldNames } = createWorkflowFromTemplate(template, {
        documentId: '',
        tableId: '',
        tableName: '',
        schema: null,
      })
      const def = await createWorkflow(input)
      if (unresolvedFieldNames.length > 0) {
        try {
          window.sessionStorage.setItem(
            `kition:workflow:template-unresolved:${def.id}`,
            JSON.stringify(unresolvedFieldNames),
          )
        } catch {
          // sessionStorage may be unavailable; banner is non-critical.
        }
      }
      await deps.refresh()
      deps.onCreated(def.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply template')
    } finally {
      setBusyAction(null)
      setBusyTemplateId(undefined)
    }
  }, [deps])

  const handleAgent = useCallback(() => {
    window.dispatchEvent(new CustomEvent('kition:assistant:open', {
      detail: { source: 'workflow-home-launcher' },
    }))
  }, [])

  return {
    busyAction,
    busyTemplateId,
    error,
    clearError,
    runScratch,
    runTemplate,
    handleAgent,
  }
}
