import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import type { WorkflowDefinition } from '@/features/workflow/api'
import {
  type ValidationErrors,
  type WorkflowDraft,
  changedFields,
  draftsEqual,
  emptyDraft,
  toDraft,
  validateDraft,
} from '@/features/workflow/lib/workflowDraft'

/**
 * useWorkflowDraftState — owns the (draft, originalDraft) editing pair
 * for the currently-selected workflow and the four derivations the page
 * leans on (validation, draftDirty, draftDirtyFields, the canonical
 * setDraft / setOriginalDraft setters).
 *
 * Extracted from WorkflowHomePage (WF-C1j4). The draft lifecycle is:
 *
 *   1. On mount / `selected` swap, sync from server state via toDraft().
 *      Both draft and originalDraft are seeded so dirty-detection
 *      starts clean.
 *   2. Per-field handlers (panels, drawers) call setDraft() — typically
 *      a functional update that merges one slot at a time.
 *   3. Save commits via the page's patchWorkflow flow; the page then
 *      calls setOriginalDraft(toDraft(updated)) to mark clean.
 *   4. Discard restores originalDraft into draft.
 *
 * The hook is intentionally narrower than the original WorkflowHomePage
 * had: it does NOT own the graph (filters), the connections modal, or
 * any of the save side effects. Those overlap with the page's list
 * state, refresh, and selection management — extracting them too would
 * bind this hook to the page's larger surface.
 *
 * dirty / dirtyFields here are DRAFT-only. The page unions them with
 * the graph state's dirty bit so the SaveBar reflects either source of
 * change. (Graph dirty will move to its own hook in WF-C1j5.)
 */
export interface UseWorkflowDraftStateResult {
  draft: WorkflowDraft
  originalDraft: WorkflowDraft
  setDraft: Dispatch<SetStateAction<WorkflowDraft>>
  /** Caller invokes this after a successful save to mark the draft
   *  clean (originalDraft becomes a snapshot of the server's confirmed
   *  state). */
  setOriginalDraft: Dispatch<SetStateAction<WorkflowDraft>>
  validation: ValidationErrors
  /** True when draft has any unsaved edits vs. originalDraft. The page
   *  unions this with the graph's dirty bit before driving SaveBar. */
  draftDirty: boolean
  /** Human-readable list of changed fields (e.g. ["Name", "Body"]).
   *  Page unions with graph's "Workflow" sentinel before rendering the
   *  unsaved-changes confirm dialog. */
  draftDirtyFields: string[]
}

export function useWorkflowDraftState(selected: WorkflowDefinition | null): UseWorkflowDraftStateResult {
  const [draft, setDraft] = useState<WorkflowDraft>(() => emptyDraft())
  const [originalDraft, setOriginalDraft] = useState<WorkflowDraft>(() => emptyDraft())

  // Sync the draft pair from server state when the selected workflow
  // changes (and on the very first mount). The page may also push a
  // fresh server snapshot into originalDraft after a save — that path
  // intentionally bypasses this effect.
  useEffect(() => {
    if (selected) {
      const next = toDraft(selected)
      setDraft(next)
      setOriginalDraft(next)
    } else {
      const empty = emptyDraft()
      setDraft(empty)
      setOriginalDraft(empty)
    }
  }, [selected])

  const validation = useMemo(() => validateDraft(draft), [draft])
  const draftDirty = useMemo(() => !draftsEqual(draft, originalDraft), [draft, originalDraft])
  const draftDirtyFields = useMemo(() => changedFields(draft, originalDraft), [draft, originalDraft])

  return {
    draft,
    originalDraft,
    setDraft,
    setOriginalDraft,
    validation,
    draftDirty,
    draftDirtyFields,
  }
}
