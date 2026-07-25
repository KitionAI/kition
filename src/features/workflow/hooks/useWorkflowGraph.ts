import { useCallback, useMemo } from 'react'
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from '@/features/workflow/api'

/**
 * useWorkflowGraph normalises an WorkflowDefinition into a single
 * authoritative nodes[] list + edges[] list, hiding the v1/v2 schema split
 * from the rendering layer. The legacy trigger/action stay as the source of
 * truth for those two; filter nodes come from the v2-only nodes[] payload.
 *
 * Returns the ordered visible nodes plus mutation helpers (insert, remove,
 * duplicate, toggleDisabled, updateFilter) that produce the new nodes[] +
 * edges[] arrays for the patchWorkflow payload. None of these helpers
 * mutates — callers pass the result back to the server.
 */
export type GraphNode = {
  nodeId: string
  kind: 'trigger' | 'action' | 'filter'
  config: Record<string, unknown>
  disabled?: boolean
}

export type GraphState = {
  nodes: GraphNode[]
  edges: WorkflowEdge[]
}

export function normaliseGraph(workflow: WorkflowDefinition | null): GraphState {
  if (!workflow) return { nodes: [], edges: [] }
  const nodes: GraphNode[] = []
  const triggerNodeId = workflow.trigger.nodeId || 'trigger_1'
  nodes.push({
    nodeId: triggerNodeId,
    kind: 'trigger',
    config: {
      nodeId: triggerNodeId,
      type: workflow.trigger.type,
      tableId: workflow.trigger.tableId,
      documentId: workflow.trigger.documentId,
    },
  })
  // Extra nodes (filters) live in nodes[]; we slot them between the
  // trigger and primary action when no edge wiring is present.
  const extras = (workflow.nodes || []).filter((n) => n.kind === 'filter')
  for (const node of extras) {
    nodes.push({
      nodeId: node.nodeId,
      kind: 'filter',
      config: node.config || {},
      disabled: Boolean((node.config as { disabled?: boolean })?.disabled),
    })
  }
  const actionNodeId = workflow.action.nodeId || 'action_1'
  nodes.push({
    nodeId: actionNodeId,
    kind: 'action',
    config: {
      nodeId: actionNodeId,
      type: workflow.action.type,
      connectionId: workflow.action.connectionId,
      to: workflow.action.to,
      subject: workflow.action.subject,
      body: workflow.action.body,
      addRecord: workflow.action.addRecord,
      updateRecord: workflow.action.updateRecord,
      lookupRecord: workflow.action.lookupRecord,
      transformRecord: workflow.action.transformRecord,
    },
  })
  // Synthesize linear edges trigger → … → action.
  const edges: WorkflowEdge[] = []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    edges.push({ from: nodes[i].nodeId, to: nodes[i + 1].nodeId })
  }
  return { nodes, edges }
}

/** Re-link edges as a strict linear chain over the current nodes order. */
export function linearizeEdges(nodes: GraphNode[]): WorkflowEdge[] {
  const out: WorkflowEdge[] = []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    out.push({ from: nodes[i].nodeId, to: nodes[i + 1].nodeId })
  }
  return out
}

export function useWorkflowGraph(workflow: WorkflowDefinition | null) {
  const state = useMemo(() => normaliseGraph(workflow), [workflow])

  const insertAt = useCallback((index: number, node: GraphNode): GraphState => {
    const nodes = [...state.nodes]
    nodes.splice(index, 0, node)
    return { nodes, edges: linearizeEdges(nodes) }
  }, [state])

  const removeAt = useCallback((index: number): GraphState => {
    const nodes = state.nodes.filter((_, i) => i !== index)
    return { nodes, edges: linearizeEdges(nodes) }
  }, [state])

  const duplicateAt = useCallback((index: number): GraphState => {
    const original = state.nodes[index]
    if (!original) return state
    const clone: GraphNode = {
      ...original,
      nodeId: `${original.kind}_${Date.now().toString(36)}`,
    }
    const nodes = [...state.nodes]
    nodes.splice(index + 1, 0, clone)
    return { nodes, edges: linearizeEdges(nodes) }
  }, [state])

  const setDisabledAt = useCallback((index: number, disabled: boolean): GraphState => {
    const nodes = state.nodes.map((n, i) => i === index ? { ...n, disabled } : n)
    return { nodes, edges: state.edges }
  }, [state])

  return { state, insertAt, removeAt, duplicateAt, setDisabledAt }
}

/** Filter nodes that go on the wire (only filters; trigger/action come
 *  from the legacy shape). */
export function filtersForPatch(state: GraphState): WorkflowNode[] {
  return state.nodes
    .filter((n) => n.kind === 'filter')
    .map((n) => ({
      nodeId: n.nodeId,
      kind: 'filter' as const,
      config: { ...n.config, disabled: n.disabled || undefined },
    }))
}
