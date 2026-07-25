import { describe, expect, it } from 'vitest'

import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import { graphNodesEqual, parseIdAsNumber } from '@/features/workflow/lib/workflowDraft'

const baseNode = (over: Partial<GraphNode> = {}): GraphNode => ({
  nodeId: 'trigger_1',
  kind: 'trigger',
  config: { type: 'record_created', tableId: 'tbl_leads' },
  ...over,
})

describe('graphNodesEqual', () => {
  it('returns true for two empty arrays', () => {
    expect(graphNodesEqual([], [])).toBe(true)
  })

  it('returns true when the same array reference is passed on both sides', () => {
    const nodes = [baseNode()]
    expect(graphNodesEqual(nodes, nodes)).toBe(true)
  })

  it('returns true when node fields match structurally even across array clones', () => {
    const a = [baseNode(), baseNode({ nodeId: 'action_1', kind: 'action', config: { type: 'send_email' } })]
    const b = [baseNode(), baseNode({ nodeId: 'action_1', kind: 'action', config: { type: 'send_email' } })]
    expect(graphNodesEqual(a, b)).toBe(true)
  })

  it('returns false on length mismatch', () => {
    const a = [baseNode()]
    const b: GraphNode[] = []
    expect(graphNodesEqual(a, b)).toBe(false)
  })

  it('returns false when nodeId differs at any index', () => {
    const a = [baseNode({ nodeId: 'trigger_1' })]
    const b = [baseNode({ nodeId: 'trigger_2' })]
    expect(graphNodesEqual(a, b)).toBe(false)
  })

  it('returns false when kind differs', () => {
    const a = [baseNode({ kind: 'filter' })]
    const b = [baseNode({ kind: 'action' })]
    expect(graphNodesEqual(a, b)).toBe(false)
  })

  it('returns false when disabled flag differs (normalizing undefined to false)', () => {
    const a = [baseNode({ disabled: true })]
    const b = [baseNode({ disabled: false })]
    expect(graphNodesEqual(a, b)).toBe(false)
    // Missing disabled defaults to false, so omitted and explicit-false match.
    const c = [baseNode({ disabled: undefined })]
    const d = [baseNode({ disabled: false })]
    expect(graphNodesEqual(c, d)).toBe(true)
  })

  it('returns false when nested config diverges', () => {
    const a = [baseNode({ config: { mode: 'all', conditions: [{ field: 'name', op: 'eq', value: 'A' }] } })]
    const b = [baseNode({ config: { mode: 'all', conditions: [{ field: 'name', op: 'eq', value: 'B' }] } })]
    expect(graphNodesEqual(a, b)).toBe(false)
  })

  it('preserves order sensitivity — reordering nodes is a real change', () => {
    const a: GraphNode[] = [
      baseNode({ nodeId: 'trigger_1' }),
      baseNode({ nodeId: 'filter_1', kind: 'filter' }),
      baseNode({ nodeId: 'action_1', kind: 'action' }),
    ]
    const b: GraphNode[] = [
      baseNode({ nodeId: 'trigger_1' }),
      baseNode({ nodeId: 'action_1', kind: 'action' }),
      baseNode({ nodeId: 'filter_1', kind: 'filter' }),
    ]
    expect(graphNodesEqual(a, b)).toBe(false)
  })
})

describe('parseIdAsNumber', () => {
  it('returns the numeric value for valid positive numbers', () => {
    expect(parseIdAsNumber('42')).toBe(42)
    expect(parseIdAsNumber('7')).toBe(7)
  })

  it('returns null for empty/undefined input so the picker can render its no-binding state', () => {
    expect(parseIdAsNumber(undefined)).toBe(null)
    expect(parseIdAsNumber('')).toBe(null)
  })

  it('returns null for non-numeric strings so a bad workflow definition does not call /records with NaN', () => {
    expect(parseIdAsNumber('not-a-number')).toBe(null)
    expect(parseIdAsNumber('1.2.3')).toBe(null)
  })

  it('returns null for zero and negative numbers — IDs in this schema are positive', () => {
    expect(parseIdAsNumber('0')).toBe(null)
    expect(parseIdAsNumber('-3')).toBe(null)
  })
})
