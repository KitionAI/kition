/**
 * Trigger edits from the properties drawer. Each commits at once through
 * PATCH instead of the draft-then-Save loop, because a trigger change
 * reshapes the rest of the editor (schema reload, body token validity,
 * which panels show). Rebinding the table first checks for body field
 * refs the new table cannot resolve and asks before pruning them.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import { patchWorkflow, type WorkflowDefinition } from '@/api/workflows'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { findDanglingFieldRefs, type TableLabel } from '@/features/workflow/lib/workflowDraft'
import {
  buildTriggerTablePatch,
  buildTriggerTypePatch,
  pruneRequiredFieldIds,
  sameStringList,
  type WorkflowTriggerType,
} from '@/features/workflow/lib/workflowPatches'
import type { ConfirmState } from '@/features/workflow/pages/WorkflowHomePageConfirm'

type UseWorkflowTriggerEditorOptions = {
  selected: WorkflowDefinition | null
  tableLabels: Record<string, TableLabel>
  ensureSchema: (documentId: string, tableId: string) => Promise<TableSchema | null>
  setWorkflows: Dispatch<SetStateAction<WorkflowDefinition[]>>
  setSavingDraft: (saving: boolean) => void
  setError: (message: string) => void
  setConfirm: (state: ConfirmState | null) => void
}

export function useWorkflowTriggerEditor({
  selected,
  tableLabels,
  ensureSchema,
  setWorkflows,
  setSavingDraft,
  setError,
  setConfirm,
}: UseWorkflowTriggerEditorOptions) {
  const { t } = useTranslation('workflow')

  const commit = useCallback(async (
    run: () => Promise<WorkflowDefinition>,
    failureMessage: string,
  ) => {
    setSavingDraft(true)
    setError('')
    try {
      const updated = await run()
      setWorkflows((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : failureMessage)
    } finally {
      setSavingDraft(false)
    }
  }, [setError, setSavingDraft, setWorkflows])

  const commitTriggerTableSwap = useCallback(async (input: { nextTableId: string; nextDocumentId: string; pruneFieldIds: string[] }) => {
    if (!selected) return
    await commit(async () => {
      // Required-field ids the new table does not have can never gate a run; drop them.
      const currentRequired = selected.trigger.requiredFields || []
      const schema = currentRequired.length > 0 ? await ensureSchema(input.nextDocumentId, input.nextTableId) : null
      return patchWorkflow(selected.id, buildTriggerTablePatch({
        selected,
        nextTableId: input.nextTableId,
        nextDocumentId: input.nextDocumentId,
        pruneFieldIds: input.pruneFieldIds,
        requiredFields: pruneRequiredFieldIds(currentRequired, schema),
      }))
    }, 'Failed to update trigger table')
  }, [commit, ensureSchema, selected])

  /** Bind or rebind the trigger's table; an empty id unbinds it back to a draft. */
  const setTriggerTable = useCallback(async (nextTableId: string) => {
    if (!selected) return
    const label = nextTableId ? tableLabels[nextTableId] : null
    const nextDocumentId = label?.documentId || ''
    if (nextTableId === selected.trigger.tableId && nextDocumentId === selected.trigger.documentId) return

    // add_record bodies are per-field templates and are not checked yet.
    if (nextTableId && nextDocumentId && selected.action.type !== 'add_record') {
      const schema = await ensureSchema(nextDocumentId, nextTableId)
      const danglingIds = schema ? findDanglingFieldRefs(selected.action.body, schema) : []
      if (danglingIds.length > 0) {
        await new Promise<void>((resolve) => {
          setConfirm({
            title: t('confirms.switchTriggerTable.title', { tableName: label?.tableName || t('confirms.switchTriggerTable.tableFallback') }),
            message: t('confirms.switchTriggerTable.message', { count: danglingIds.length }),
            confirmLabel: t('confirms.switchTriggerTable.confirm'),
            destructive: true,
            onConfirm: () => {
              void commitTriggerTableSwap({ nextTableId, nextDocumentId, pruneFieldIds: danglingIds }).then(resolve, resolve)
            },
          })
          // Cancel keeps the current table; callers do not await beyond errors.
        })
        return
      }
    }
    await commitTriggerTableSwap({ nextTableId, nextDocumentId, pruneFieldIds: [] })
  }, [commitTriggerTableSwap, ensureSchema, selected, setConfirm, t, tableLabels])

  /** An empty cron leaves a scheduled draft the runtime accepts while disabled. */
  const setTriggerSchedule = useCallback(async (next: { cron: string; timezone: string }) => {
    if (!selected) return
    const cron = next.cron.trim()
    const timezone = next.timezone.trim()
    if (cron === (selected.trigger.schedule?.cron || '').trim() && timezone === (selected.trigger.schedule?.timezone || '').trim()) return
    await commit(
      () => patchWorkflow(selected.id, { trigger: { nodeId: selected.trigger.nodeId, type: 'scheduled_time', schedule: { cron, timezone } } }),
      'Failed to update schedule',
    )
  }, [commit, selected])

  const setTriggerType = useCallback(async (nextType: WorkflowTriggerType) => {
    if (!selected) return
    if ((selected.trigger.type || 'record_created') === nextType) return
    await commit(
      () => patchWorkflow(selected.id, { trigger: buildTriggerTypePatch(selected.trigger, nextType) }),
      'Failed to update trigger type',
    )
  }, [commit, selected])

  /** Sends the list as-is: the runtime treats [] as clear and [...] as replace. */
  const setTriggerRequiredFields = useCallback(async (next: string[]) => {
    if (!selected) return
    if (sameStringList(selected.trigger.requiredFields || [], next)) return
    await commit(
      () => patchWorkflow(selected.id, { trigger: { nodeId: selected.trigger.nodeId, requiredFields: next } }),
      'Failed to update required fields',
    )
  }, [commit, selected])

  return { setTriggerTable, setTriggerSchedule, setTriggerType, setTriggerRequiredFields }
}
