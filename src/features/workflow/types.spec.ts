import { describe, expect, it } from 'vitest'
import { parseWorkflowBuildEvent } from './types'

describe('parseWorkflowBuildEvent', () => {
  it('parses workflow.generated', () => {
    const raw = JSON.stringify({ kind: 'workflow.generated', workflowId: 'auto_x', name: 'N', description: 'D' })
    const ev = parseWorkflowBuildEvent(raw)
    expect(ev?.kind).toBe('workflow.generated')
    expect(ev?.kind === 'workflow.generated' && ev.workflowId).toBe('auto_x')
  })

  it('parses trigger.generated with config', () => {
    const raw = JSON.stringify({ kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl_x', config: { tableId: 'tbl_x' } })
    const ev = parseWorkflowBuildEvent(raw)
    expect(ev?.kind).toBe('trigger.generated')
    expect(ev?.kind === 'trigger.generated' && ev.triggerType).toBe('record_created')
  })

  it('returns null for invalid JSON', () => {
    expect(parseWorkflowBuildEvent('not-json')).toBeNull()
  })

  it('returns null for unknown kind', () => {
    expect(parseWorkflowBuildEvent(JSON.stringify({ kind: 'weird' }))).toBeNull()
  })

  it('parses done as empty', () => {
    const ev = parseWorkflowBuildEvent(JSON.stringify({ kind: 'done' }))
    expect(ev?.kind).toBe('done')
  })

  it('returns null for trigger.generated missing config', () => {
    const raw = JSON.stringify({ kind: 'trigger.generated', nodeId: 'n1', triggerType: 'record_created', tableId: 'tbl_x' })
    expect(parseWorkflowBuildEvent(raw)).toBeNull()
  })
})
