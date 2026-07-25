import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkflowDefinition } from '@/features/workflow/api'

import { useWorkflowGraphState } from './useWorkflowGraphState'

function HookSurface({ onResult, selected }: {
  onResult: (r: ReturnType<typeof useWorkflowGraphState>) => void
  selected: WorkflowDefinition | null
}) {
  const result = useWorkflowGraphState(selected)
  useEffect(() => onResult(result), [result, onResult])
  return null
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})
afterEach(() => {
  root?.unmount()
  container.remove()
})

async function mount(node: ReturnType<typeof createElement>) {
  await act(async () => {
    root = createRoot(container)
    root.render(node)
    await Promise.resolve()
  })
}

function makeWorkflow(over: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const triggerNodeId = 'trigger_1'
  const actionNodeId = 'action_1'
  return {
    id: 'wf_a',
    name: 'Sample',
    description: '',
    enabled: false,
    trigger: { nodeId: triggerNodeId, type: 'record_created', tableId: 'tbl_leads', documentId: 'doc_1' } as any,
    action: {
      nodeId: actionNodeId,
      type: 'send_email',
      connectionId: 'conn_a',
      to: 'team@example.com',
      subject: { parts: [{ kind: 'text' as const, text: 'New lead' }] },
      body: { parts: [{ kind: 'text', text: 'hi' }] },
    } as any,
    ...over,
  } as WorkflowDefinition
}

describe('useWorkflowGraphState', () => {
  it('initialises empty when selected is null', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: null }))
    expect(captured!.graphNodes).toEqual([])
    expect(captured!.originalGraphNodes).toEqual([])
    expect(captured!.graphDirty).toBe(false)
  })

  it('seeds graphNodes + originalGraphNodes from selected via normaliseGraph on mount', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    // The minimal trigger + action shape produces two nodes after
    // normaliseGraph synthesises the wiring.
    expect(captured!.graphNodes.length).toBeGreaterThanOrEqual(2)
    expect(captured!.originalGraphNodes.length).toBeGreaterThanOrEqual(2)
    expect(captured!.graphDirty).toBe(false)
    // Both pairs structurally match on the initial seed — graphDirty
    // is the contract that catches divergence.
    expect(captured!.graphNodes).toEqual(captured!.originalGraphNodes)
  })

  it('marks graphDirty when graphNodes mutates structurally from originalGraphNodes', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    expect(captured!.graphDirty).toBe(false)
    await act(async () => {
      captured!.setGraphNodes((current) => [
        ...current,
        { nodeId: 'filter_inserted', kind: 'filter', config: { mode: 'all' }, disabled: false } as any,
      ])
    })
    expect(captured!.graphDirty).toBe(true)
  })

  it('graphDirty returns false when graph swaps back to the same shape', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    const snapshot = captured!.originalGraphNodes
    await act(async () => {
      // Mutate then restore — graphDirty should track equivalence, not
      // reference identity. (graphNodesEqual short-circuits on length /
      // nodeId / kind / config; it tolerates fresh array references.)
      captured!.setGraphNodes((current) => [...current])
    })
    expect(captured!.graphNodes).not.toBe(snapshot)
    expect(captured!.graphDirty).toBe(false)
  })

  it('re-syncs both pairs when selected swaps to a different workflow', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    const first = makeWorkflow({ id: 'wf_a' })
    const second = makeWorkflow({ id: 'wf_b', trigger: { ...makeWorkflow().trigger, tableId: 'tbl_other' } as any })
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: first }))
    // Mutate graphNodes so the pair is dirty against the first snapshot.
    await act(async () => {
      captured!.setGraphNodes((current) => [...current])
    })
    // Now swap workflows — sync effect should reset both pairs from
    // the new workflow's normaliseGraph output.
    await act(async () => {
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: second }))
      await Promise.resolve()
    })
    expect(captured!.graphDirty).toBe(false)
    // The trigger.tableId on the trigger config should reflect wf_b.
    const triggerNode = captured!.graphNodes.find((n) => n.kind === 'trigger')
    expect((triggerNode?.config as any)?.tableId).toBe('tbl_other')
  })

  it('switching to null clears both pairs and graphDirty stays false', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    expect(captured!.graphNodes.length).toBeGreaterThan(0)
    await act(async () => {
      root!.render(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: null }))
      await Promise.resolve()
    })
    expect(captured!.graphNodes).toEqual([])
    expect(captured!.originalGraphNodes).toEqual([])
    expect(captured!.graphDirty).toBe(false)
  })

  it('setOriginalGraphNodes is the post-save cleanup contract — calling it with the current graphNodes goes clean', async () => {
    let captured: ReturnType<typeof useWorkflowGraphState> | null = null
    await mount(createElement(HookSurface, { onResult: (r) => { captured = r }, selected: makeWorkflow() }))
    await act(async () => {
      captured!.setGraphNodes((current) => [
        ...current,
        { nodeId: 'filter_added', kind: 'filter', config: { mode: 'all' }, disabled: false } as any,
      ])
    })
    expect(captured!.graphDirty).toBe(true)
    // Simulate post-save: page calls setOriginalGraphNodes(graph.nodes)
    // after the server confirmed the new wiring.
    await act(async () => {
      captured!.setOriginalGraphNodes(captured!.graphNodes)
    })
    expect(captured!.graphDirty).toBe(false)
  })
})
