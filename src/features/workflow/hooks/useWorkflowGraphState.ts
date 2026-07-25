import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import type { WorkflowDefinition } from '@/features/workflow/api'
import { normaliseGraph, type GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import { graphNodesEqual } from '@/features/workflow/lib/workflowDraft'

/**
 * useWorkflowGraphState — owns the (graphNodes, originalGraphNodes)
 * pair for the canvas's filter chain and exposes a `graphDirty`
 * derivation matching `useWorkflowDraftState.draftDirty`. The page
 * unions the two dirty bits to drive SaveBar + dirty-fields confirm
 * copy.
 *
 * Extracted from WorkflowHomePage (WF-C1j5). Graph state is parallel
 * to draft state: it syncs from `selected` on workflow swap, mutates
 * via panel-/canvas-level handlers (insert/delete/duplicate filter),
 * and goes clean again when the page commits a save (the page calls
 * setOriginalGraphNodes(graph.nodes) after a successful PATCH).
 *
 * Filter dry-run, ConfirmDialog wiring, and graph→patch translation
 * (filtersForPatch) all stay on the page — the hook's purpose is to
 * own the state pair and the sync/dirty contract, not the broader
 * canvas behavior.
 */
export interface UseWorkflowGraphStateResult {
  graphNodes: GraphNode[]
  originalGraphNodes: GraphNode[]
  setGraphNodes: Dispatch<SetStateAction<GraphNode[]>>
  /** Caller invokes this after a successful save (the page already
   *  passes the new graph via normaliseGraph from the server response). */
  setOriginalGraphNodes: Dispatch<SetStateAction<GraphNode[]>>
  /** True when graphNodes has structural diffs vs. originalGraphNodes.
   *  Page unions with draftDirty before driving SaveBar. */
  graphDirty: boolean
}

export function useWorkflowGraphState(selected: WorkflowDefinition | null): UseWorkflowGraphStateResult {
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [originalGraphNodes, setOriginalGraphNodes] = useState<GraphNode[]>([])

  // Sync the pair from server state when `selected` swaps. Matches the
  // draft-state hook's contract — both reset on the same `selected`
  // identity change so dirty-detection stays in lockstep with the
  // canonical workflow snapshot.
  useEffect(() => {
    if (selected) {
      const graph = normaliseGraph(selected)
      setGraphNodes(graph.nodes)
      setOriginalGraphNodes(graph.nodes)
    } else {
      setGraphNodes([])
      setOriginalGraphNodes([])
    }
  }, [selected])

  const graphDirty = useMemo(
    () => !graphNodesEqual(graphNodes, originalGraphNodes),
    [graphNodes, originalGraphNodes],
  )

  return {
    graphNodes,
    originalGraphNodes,
    setGraphNodes,
    setOriginalGraphNodes,
    graphDirty,
  }
}
