import { useCallback, useState } from 'react'

import { openWorkflowRoute, type WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import type { WorkflowTemplate } from '@/features/workflow/templates'
import type { WorkspaceWorkflowCreateModeChoice } from '@/features/workspace/components/WorkspaceWorkflowCreateModeDialog'

/**
 * useWorkflowModeDialogState — owns the four bits of state that drive the
 * create-workflow mode-chooser dialog: open flag, optional pre-bound
 * workflow context, the busy/template id (for spinner placement), and the
 * error slot.
 *
 * Extracted from WorkflowHomePage (WF-C1g). The dialog's three lifecycle
 * events (open / close / select-choice) live here so the page's render
 * tree only sees a fat result object instead of five setState calls
 * sprinkled across the file.
 *
 * The `handleSelect` callback takes a small dependency bag rather than
 * closing over runTemplateUnbound / refresh — the page still owns those
 * (they touch the workflow list state), but the hook owns the dialog's
 * own success/error lifecycle. That split lets the dialog hook stay
 * pure while delegating the workflow-creation side effect upward.
 */
export interface UseWorkflowModeDialogStateResult {
  /** Whether the dialog is mounted as open. */
  open: boolean
  /** Optional pre-bound document/table context. Lets a caller push the
   *  user into the dialog with a pre-selected table; on this page the
   *  upstream table-picker handoff was removed, so this is always null
   *  today, but it stays on the surface so a future caller can wire it. */
  context: WorkflowRouteContext | null
  busyKind: 'template' | 'chat' | 'scratch' | null
  busyTemplateId: string | undefined
  error: string | null
  setContext: (next: WorkflowRouteContext | null) => void
  openDialog: () => void
  closeDialog: () => void
  /** Handles the dialog's choice callback. The chat branch has two
   *  flavors: when a context is already pinned it navigates to the
   *  /workflow/new?mode=ai surface; when context is null (top "Create"
   *  button, kitable Workflows landing) it creates an unbound draft via
   *  the supplied runScratch — same delayed-binding contract the
   *  template branch uses — and pops the assistant panel so the user
   *  still has an AI affordance for refinement. The scratch branch is
   *  the same unbound-draft flow but without the assistant nudge — the
   *  user explicitly opted out of AI. Template branch delegates to
   *  runTemplate. */
  handleSelect: (
    choice: WorkspaceWorkflowCreateModeChoice,
    deps: {
      runTemplate: (template: WorkflowTemplate) => Promise<void>
      runScratch: () => Promise<void>
    },
  ) => void
}

export interface UseWorkflowModeDialogStateOptions {
  /** Mount the dialog already open — drives the page's
   *  `initialModeDialogOpen` prop so deep-linking from `/workflow/new`
   *  doesn't require a follow-up click. */
  initialOpen?: boolean
  /** Fired before transitioning to open. The page uses this to clear the
   *  launcher's error toast so the dialog doesn't pop over a stale
   *  message that belongs to the previous attempt. Optional. */
  onBeforeOpen?: () => void
}

export function useWorkflowModeDialogState(
  options: UseWorkflowModeDialogStateOptions = {},
): UseWorkflowModeDialogStateResult {
  const { initialOpen = false, onBeforeOpen } = options
  const [open, setOpen] = useState(initialOpen)
  const [context, setContext] = useState<WorkflowRouteContext | null>(null)
  const [busyKind, setBusyKind] = useState<'template' | 'chat' | 'scratch' | null>(null)
  const [busyTemplateId, setBusyTemplateId] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const openDialog = useCallback(() => {
    onBeforeOpen?.()
    setError(null)
    setBusyKind(null)
    setBusyTemplateId(undefined)
    setContext(null)
    setOpen(true)
  }, [onBeforeOpen])

  const closeDialog = useCallback(() => {
    setOpen(false)
    setContext(null)
    setError(null)
    setBusyKind(null)
    setBusyTemplateId(undefined)
  }, [])

  const handleSelect = useCallback(
    (
      choice: WorkspaceWorkflowCreateModeChoice,
      deps: {
        runTemplate: (template: WorkflowTemplate) => Promise<void>
        runScratch: () => Promise<void>
      },
    ) => {
      if (choice.kind === 'chat') {
        closeDialog()
        // WorkflowRoute now resolves no-context /workflow/new?mode=ai to
        // the dedicated `ai-no-context` mode that renders the AI prompt
        // page with an empty tableContext (instead of looping back to
        // this same mode dialog). So both branches just navigate — no
        // need for the silent runScratch + assistant-open hack, which
        // confusingly created an "Email someone on every new record"
        // template draft when the user had only asked for an AI chat
        // surface.
        openWorkflowRoute(context, { mode: 'ai' })
        return
      }
      if (choice.kind === 'scratch') {
        // The user explicitly picked "from scratch" — same unbound-draft
        // creation as the AI-without-context branch above, minus the
        // assistant panel nudge. Picking scratch is the user signaling
        // they want to drive the configuration themselves, so we deliberately
        // do NOT pop the AI surface afterwards.
        setError(null)
        setBusyKind('scratch')
        void (async () => {
          try {
            await deps.runScratch()
            closeDialog()
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create workflow')
            setBusyKind(null)
          }
        })()
        return
      }
      setError(null)
      setBusyKind('template')
      setBusyTemplateId(choice.template.id)
      void (async () => {
        try {
          await deps.runTemplate(choice.template)
          closeDialog()
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to apply template')
          setBusyKind(null)
          setBusyTemplateId(undefined)
        }
      })()
    },
    [closeDialog, context],
  )

  return {
    open,
    context,
    busyKind,
    busyTemplateId,
    error,
    setContext,
    openDialog,
    closeDialog,
    handleSelect,
  }
}
