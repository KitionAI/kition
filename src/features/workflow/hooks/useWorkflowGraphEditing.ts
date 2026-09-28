/**
 * Canvas edits on the node chain: delete, duplicate, disable, and insert.
 * The trigger and the primary action are singletons, so deleting the
 * trigger means deleting the workflow and the action cannot be removed.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'

import type { WorkflowDefinition } from '@/api/workflows'
import type { InsertableActionType } from '@/features/workflow/canvas/WorkflowNodePicker'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowDraft } from '@/features/workflow/lib/workflowDraft'
import {
  cloneFilterGraphNode,
  createFilterGraphNode,
  DEFAULT_ACTION_NODE_ID,
  draftForActionType,
} from '@/features/workflow/lib/workflowPatches'
import type { ConfirmState } from '@/features/workflow/pages/WorkflowHomePageConfirm'

type UseWorkflowGraphEditingOptions = {
  selected: WorkflowDefinition | null
  graphNodes: GraphNode[]
  setGraphNodes: Dispatch<SetStateAction<GraphNode[]>>
  selectedNodeId: string
  setSelectedNodeId: (nodeId: string) => void
  setDraft: Dispatch<SetStateAction<WorkflowDraft>>
  setDrawerOpen: (open: boolean) => void
  setConfirm: (state: ConfirmState | null) => void
  setError: (message: string) => void
  /** Deleting the trigger deletes the workflow, after confirmation. */
  onDeleteWorkflow: () => void
}

export function useWorkflowGraphEditing({
  selected,
  graphNodes,
  setGraphNodes,
  selectedNodeId,
  setSelectedNodeId,
  setDraft,
  setDrawerOpen,
  setConfirm,
  setError,
  onDeleteWorkflow,
}: UseWorkflowGraphEditingOptions) {
  const { t } = useTranslation('workflow')

  const deleteNode = useCallback((nodeId: string) => {
    if (!selected) return
    const index = graphNodes.findIndex((node) => node.nodeId === nodeId)
    if (index < 0) return
    const node = graphNodes[index]
    if (node.kind === 'trigger') {
      setConfirm({
        title: t('confirms.deleteTriggerWorkflow.title'),
        message: t('confirms.deleteTriggerWorkflow.message'),
        confirmLabel: t('confirms.deleteTriggerWorkflow.confirm'),
        destructive: true,
        onConfirm: onDeleteWorkflow,
      })
      return
    }
    if (node.kind === 'action') {
      setError(t('errors.primaryActionLocked'))
      return
    }
    setConfirm({
      title: t('confirms.deleteFilter.title'),
      message: t('confirms.deleteFilter.message'),
      confirmLabel: t('confirms.deleteFilter.confirm'),
      destructive: true,
      onConfirm: () => {
        setGraphNodes(graphNodes.filter((_, position) => position !== index))
        if (selectedNodeId === nodeId) setSelectedNodeId(selected.action.nodeId || DEFAULT_ACTION_NODE_ID)
      },
    })
  }, [graphNodes, onDeleteWorkflow, selected, selectedNodeId, setConfirm, setError, setGraphNodes, setSelectedNodeId, t])

  const duplicateNode = useCallback((nodeId: string) => {
    if (!selected) return
    const index = graphNodes.findIndex((node) => node.nodeId === nodeId)
    if (index < 0) return
    const original = graphNodes[index]
    if (original.kind !== 'filter') {
      setError(`${original.kind} nodes can't be duplicated in this release.`)
      return
    }
    const next = [...graphNodes]
    next.splice(index + 1, 0, cloneFilterGraphNode(original))
    setGraphNodes(next)
  }, [graphNodes, selected, setError, setGraphNodes])

  const setNodeDisabled = useCallback((nodeId: string, disabled: boolean) => {
    setGraphNodes((current) => current.map((node) => (node.nodeId === nodeId ? { ...node, disabled } : node)))
  }, [setGraphNodes])

  /** Inserts a filter at `index`, or swaps the primary action's type. */
  const insertAt = useCallback((index: number, kind: 'filter' | 'action', actionType?: InsertableActionType) => {
    if (kind === 'action' && actionType) {
      setDraft((current) => draftForActionType(current, actionType))
      setSelectedNodeId(selected?.action.nodeId || DEFAULT_ACTION_NODE_ID)
      setDrawerOpen(true)
      return
    }
    if (kind !== 'filter') return
    const node = createFilterGraphNode()
    const next = [...graphNodes]
    next.splice(index, 0, node)
    setGraphNodes(next)
    setSelectedNodeId(node.nodeId)
    setDrawerOpen(true)
  }, [graphNodes, selected, setDraft, setDrawerOpen, setGraphNodes, setSelectedNodeId])

  const deleteSelectedNode = useCallback(() => {
    if (selectedNodeId) deleteNode(selectedNodeId)
  }, [deleteNode, selectedNodeId])

  return { deleteNode, duplicateNode, setNodeDisabled, insertAt, deleteSelectedNode }
}
