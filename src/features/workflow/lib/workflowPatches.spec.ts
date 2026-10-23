import { describe, expect, it } from 'vitest'

import type { WorkflowDefinition } from '@/api/workflows'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { emptyDraft, type TableLabel } from '@/features/workflow/lib/workflowDraft'

import {
  buildTriggerTableOptions,
  buildTriggerTablePatch,
  buildTriggerTypePatch,
  buildWorkflowSavePatch,
  cloneFilterGraphNode,
  countRunsByStatus,
  createFilterGraphNode,
  draftForActionType,
  filterDryRunSample,
  pruneRequiredFieldIds,
  sameStringList,
} from './workflowPatches'

const workflow = {
  id: 'wf-1',
  name: 'Leads',
  description: '',
  enabled: true,
  trigger: { nodeId: 'trigger_1', type: 'record_created', documentPath: 'crm.ktable', documentId: 'kdm-crm', tableId: '1', requiredFields: ['f1', 'f2'] },
  action: { nodeId: 'action_1', type: 'send_email', body: { parts: [{ type: 'field_ref', fieldId: 'f9' }] } },
} as unknown as WorkflowDefinition

const schema = { fields: [{ id: 'f1', name: 'Name', type: 'text' }, { id: 'f3', name: 'Amount', type: 'number' }] } as TableSchema
const labels: Record<string, TableLabel> = {
  'crm.ktable#1': { tableId: '1', tableName: 'Leads', documentTitle: 'crm', documentId: 'kdm-crm', documentPath: 'crm.ktable' },
  // The same table id in another file.
  'billing.ktable#1': { tableId: '1', tableName: 'Orders', documentTitle: 'billing', documentId: 'kdm-billing', documentPath: 'billing.ktable' },
  'crm.ktable#3': { tableId: '3', tableName: 'Accounts', documentTitle: 'crm', documentId: 'kdm-crm', documentPath: 'crm.ktable' },
}

describe('buildWorkflowSavePatch', () => {
  it('chains trigger, filters, and action with edges and trims the name', () => {
    const draft = { ...emptyDraft(), name: '  Leads  ', actionType: 'send_email', connectionId: 'c1', to: ' a@b.c ', subject: { parts: [] }, body: { parts: [] } }
    const filter: GraphNode = { nodeId: 'filter_a', kind: 'filter', config: { nodeId: 'filter_a', type: 'filter', expression: 'x', mode: 'all' } }
    const patch = buildWorkflowSavePatch({ draft, selected: workflow, graphNodes: [{ nodeId: 'trigger_1', kind: 'trigger', config: {} }, filter], tableLabels: labels })
    expect(patch.name).toBe('Leads')
    expect(patch.nodes?.map((node) => node.nodeId)).toEqual(['trigger_1', 'filter_a', 'action_1'])
    expect(patch.edges).toEqual([{ from: 'trigger_1', to: 'filter_a' }, { from: 'filter_a', to: 'action_1' }])
    expect(patch.action).toMatchObject({ connectionId: 'c1', to: 'a@b.c' })
  })

  it('resolves the add_record target file\'s id from the labels cache', () => {
    const draft = { ...emptyDraft(), actionType: 'add_record', addRecord: { targetTableId: '1', targetDocumentPath: 'billing.ktable', fields: [{ fieldId: 'f1', value: { parts: [] } }] } }
    const patch = buildWorkflowSavePatch({ draft, selected: workflow, graphNodes: [], tableLabels: labels })
    expect(patch.action).toMatchObject({ type: 'add_record', addRecord: { targetTableId: '1', targetDocumentPath: 'billing.ktable', targetDocumentId: 'kdm-billing' } })
  })

  it('names the trigger\'s file when the add_record target has no path', () => {
    const draft = { ...emptyDraft(), actionType: 'add_record', addRecord: { targetTableId: '3', fields: [] } }
    const patch = buildWorkflowSavePatch({ draft, selected: workflow, graphNodes: [], tableLabels: labels })
    expect(patch.action).toMatchObject({ addRecord: { targetTableId: '3', targetDocumentPath: 'crm.ktable', targetDocumentId: 'kdm-crm' } })
    expect(patch.nodes?.[0].config).toMatchObject({ documentPath: 'crm.ktable', tableId: '1' })
  })
})

describe('trigger patches', () => {
  it('clears the table when moving to a schedule and clears the schedule when moving back', () => {
    const toSchedule = buildTriggerTypePatch(workflow.trigger, 'scheduled_time')
    expect(toSchedule).toEqual({ nodeId: 'trigger_1', type: 'scheduled_time', documentPath: '', documentId: '', tableId: '', requiredFields: [], schedule: { cron: '', timezone: '' } })
    const back = buildTriggerTypePatch({ ...workflow.trigger, type: 'scheduled_time', schedule: { cron: '* * * * *', timezone: 'UTC' } }, 'record_updated')
    expect(back).toEqual({ nodeId: 'trigger_1', type: 'record_updated', documentPath: 'crm.ktable', documentId: 'kdm-crm', tableId: '1', schedule: { cron: '', timezone: '' } })
    const recordToRecord = buildTriggerTypePatch(workflow.trigger, 'record_updated')
    expect(recordToRecord.requiredFields).toEqual(['f1', 'f2'])
    expect(recordToRecord.schedule).toBeUndefined()
  })

  it('prunes required fields only when the new schema lacks some', () => {
    expect(pruneRequiredFieldIds(['f1', 'f2'], schema)).toEqual(['f1'])
    expect(pruneRequiredFieldIds(['f1'], schema)).toBeUndefined()
    expect(pruneRequiredFieldIds([], schema)).toBeUndefined()
    expect(pruneRequiredFieldIds(['f1'], null)).toBeUndefined()
  })

  it('rebinds the table and prunes dangling body refs only when asked', () => {
    const plain = buildTriggerTablePatch({ selected: workflow, nextTableId: '1', nextDocumentPath: 'billing.ktable', nextDocumentId: 'kdm-billing', pruneFieldIds: [], requiredFields: undefined })
    expect(plain.action).toBeUndefined()
    expect(plain.trigger).toMatchObject({ type: 'record_created', tableId: '1', documentPath: 'billing.ktable', documentId: 'kdm-billing', requiredFields: ['f1', 'f2'] })
    const pruned = buildTriggerTablePatch({ selected: workflow, nextTableId: '1', nextDocumentPath: 'billing.ktable', nextDocumentId: 'kdm-billing', pruneFieldIds: ['f9'], requiredFields: ['f1'] })
    expect(pruned.trigger?.requiredFields).toEqual(['f1'])
    expect(pruned.action?.body?.parts?.some((part) => (part as { type?: string }).type === 'field_ref')).toBe(false)
    expect(sameStringList(['a'], ['a'])).toBe(true)
    expect(sameStringList(['a'], ['b'])).toBe(false)
  })
})

describe('graph and draft helpers', () => {
  it('keeps email fields only for send_email and seeds the record configs', () => {
    const email = { ...emptyDraft(), connectionId: 'c1', to: 'x@y.z' }
    expect(draftForActionType(email, 'send_email')).toMatchObject({ connectionId: 'c1', to: 'x@y.z', addRecord: undefined })
    const add = draftForActionType(email, 'add_record')
    expect(add).toMatchObject({ actionType: 'add_record', connectionId: '', to: '', addRecord: { targetTableId: '', fields: [] } })
    expect(draftForActionType(email, 'transform_record').transformRecord).toEqual({ operations: [] })
  })

  it('creates and clones filter nodes with matching config ids', () => {
    const node = createFilterGraphNode('filter_x')
    expect(node).toEqual({ nodeId: 'filter_x', kind: 'filter', config: { nodeId: 'filter_x', type: 'filter', expression: '', mode: 'all' } })
    const clone = cloneFilterGraphNode({ ...node, config: { ...node.config, expression: 'a > 1' } }, 'filter_y')
    expect(clone.nodeId).toBe('filter_y')
    expect(clone.config).toMatchObject({ nodeId: 'filter_y', expression: 'a > 1' })
    expect(createFilterGraphNode().nodeId).toMatch(/^filter_/)
  })

  it('builds a blank sample row and counts runs by status', () => {
    expect(filterDryRunSample(schema)).toEqual({ Name: '', Amount: 0 })
    expect(filterDryRunSample(undefined)).toEqual({})
    const runs = [{ status: 'ok' }, { status: 'error' }, { status: 'ok' }, { status: 'skipped' }] as WorkflowRunRecord[]
    expect(countRunsByStatus(runs)).toEqual({ all: 4, ok: 2, error: 1, skipped: 1 })
  })

  it('scopes the trigger table picker to the table file but keeps the bound table', () => {
    expect(buildTriggerTableOptions(labels, undefined, '').map((option) => option.key)).toEqual(['billing.ktable#1', 'crm.ktable#3', 'crm.ktable#1'])
    expect(buildTriggerTableOptions(labels, 'crm.ktable', '').map((option) => option.key)).toEqual(['crm.ktable#3', 'crm.ktable#1'])
    expect(buildTriggerTableOptions(labels, 'crm.ktable', 'billing.ktable#1').map((option) => option.key)).toEqual(['billing.ktable#1', 'crm.ktable#3', 'crm.ktable#1'])
    expect(buildTriggerTableOptions(labels, undefined, '')[0]).toEqual({
      key: 'billing.ktable#1', tableId: '1', tableName: 'Orders', documentTitle: 'billing', documentPath: 'billing.ktable', documentId: 'kdm-billing',
    })
  })
})
