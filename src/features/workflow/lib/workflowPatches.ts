/**
 * Pure builders for what the workflow editor sends to the runtime and how
 * it reshapes local state: the Save patch, trigger patches, draft resets,
 * graph node factories, and small derivations for the drawer. No React,
 * no I/O, so every rule here is unit-testable.
 */
import type { WorkflowAddRecordConfig, WorkflowDefinition, WorkflowPatch } from '@/api/workflows'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { InsertableActionType } from '@/features/workflow/canvas/WorkflowNodePicker'
import { filtersForPatch, type GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { cloneBody, pruneBody, type TableLabel, type WorkflowDraft } from '@/features/workflow/lib/workflowDraft'

export type WorkflowTriggerPatch = NonNullable<WorkflowPatch['trigger']>
export type WorkflowTriggerType = 'record_created' | 'record_updated' | 'record_created_or_updated' | 'scheduled_time' | 'record_date_reached'

/** Node ids the runtime assumes when a workflow predates explicit ids. */
const DEFAULT_TRIGGER_NODE_ID = 'trigger_1'
export const DEFAULT_ACTION_NODE_ID = 'action_1'

function actionPayload(draft: WorkflowDraft, selected: WorkflowDefinition, tableLabels: Record<string, TableLabel>) {
  // The add_record panel only emits targetTableId; the runtime needs the
  // owning document too, which the labels cache already knows.
  const addRecord: WorkflowAddRecordConfig | undefined = draft.actionType === 'add_record' && draft.addRecord
    ? {
        targetTableId: draft.addRecord.targetTableId,
        targetDocumentId: draft.addRecord.targetDocumentId
          || tableLabels[draft.addRecord.targetTableId]?.documentId
          || undefined,
        fields: (draft.addRecord.fields || []).map((entry) => ({ fieldId: entry.fieldId, value: cloneBody(entry.value) })),
      }
    : undefined
  switch (draft.actionType) {
    case 'add_record':
      return { patch: { type: 'add_record' as const, addRecord }, node: { type: 'add_record', addRecord } }
    case 'update_record':
      return { patch: { type: 'update_record' as const, updateRecord: draft.updateRecord }, node: { type: 'update_record', updateRecord: draft.updateRecord } }
    case 'lookup_record':
      return { patch: { type: 'lookup_record' as const, lookupRecord: draft.lookupRecord }, node: { type: 'lookup_record', lookupRecord: draft.lookupRecord } }
    case 'transform_record':
      return { patch: { type: 'transform_record' as const, transformRecord: draft.transformRecord }, node: { type: 'transform_record', transformRecord: draft.transformRecord } }
    default: {
      const email = { connectionId: draft.connectionId, to: draft.to.trim(), subject: draft.subject, body: cloneBody(draft.body) }
      return { patch: email, node: { type: selected.action.type || 'send_email', ...email } }
    }
  }
}

/** The Save patch: name and description, the action, and the full node chain with its edges. */
export function buildWorkflowSavePatch(input: {
  draft: WorkflowDraft
  selected: WorkflowDefinition
  graphNodes: GraphNode[]
  tableLabels: Record<string, TableLabel>
}): WorkflowPatch {
  const { draft, selected, graphNodes, tableLabels } = input
  const triggerNodeId = selected.trigger.nodeId || DEFAULT_TRIGGER_NODE_ID
  const actionNodeId = selected.action.nodeId || DEFAULT_ACTION_NODE_ID
  const action = actionPayload(draft, selected, tableLabels)
  const nodes = [
    {
      nodeId: triggerNodeId,
      kind: 'trigger' as const,
      config: { nodeId: triggerNodeId, type: selected.trigger.type, tableId: selected.trigger.tableId, documentId: selected.trigger.documentId },
    },
    ...filtersForPatch({ nodes: graphNodes, edges: [] }),
    { nodeId: actionNodeId, kind: 'action' as const, config: { nodeId: actionNodeId, ...action.node } },
  ]
  const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index].nodeId, to: node.nodeId }))
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    action: action.patch,
    nodes,
    edges,
  }
}

/**
 * Switching the trigger type never leaves a half-mode trigger: moving to a
 * schedule clears the table and its required fields; moving back clears
 * the schedule and keeps whatever table was bound.
 */
export function buildTriggerTypePatch(trigger: WorkflowDefinition['trigger'], nextType: WorkflowTriggerType): WorkflowTriggerPatch {
  const currentType = trigger.type || 'record_created'
  const patch: WorkflowTriggerPatch = { nodeId: trigger.nodeId, type: nextType }
  if (nextType === 'scheduled_time') {
    patch.documentId = ''
    patch.tableId = ''
    patch.requiredFields = []
    patch.schedule = { cron: trigger.schedule?.cron || '', timezone: trigger.schedule?.timezone || '' }
    return patch
  }
  patch.documentId = trigger.documentId || ''
  patch.tableId = trigger.tableId || ''
  if (currentType === 'scheduled_time') {
    patch.schedule = { cron: '', timezone: '' }
  } else if (trigger.requiredFields !== undefined) {
    patch.requiredFields = trigger.requiredFields
  }
  return patch
}

/** Required-field ids the new table's schema still knows, or undefined when nothing has to change. */
export function pruneRequiredFieldIds(current: readonly string[], schema: TableSchema | null): string[] | undefined {
  if (current.length === 0 || !schema) return undefined
  const valid = new Set(schema.fields.map((field) => field.id))
  const pruned = current.filter((id) => valid.has(id))
  return pruned.length === current.length ? undefined : pruned
}

/** Rebinding the trigger table, optionally dropping body field refs that the new table cannot resolve. */
export function buildTriggerTablePatch(input: {
  selected: WorkflowDefinition
  nextTableId: string
  nextDocumentId: string
  pruneFieldIds: readonly string[]
  requiredFields: string[] | undefined
}): WorkflowPatch {
  const { selected } = input
  const trigger: WorkflowTriggerPatch = {
    ...selected.trigger,
    // Binding from an empty draft defaults to record_created; an existing type is kept.
    type: (selected.trigger.type || 'record_created') as WorkflowTriggerType,
    documentId: input.nextDocumentId,
    tableId: input.nextTableId,
  }
  if (input.requiredFields !== undefined) trigger.requiredFields = input.requiredFields
  if (input.pruneFieldIds.length === 0) return { trigger }
  return { trigger, action: { body: pruneBody(selected.action.body, [...input.pruneFieldIds]) } }
}

export function sameStringList(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** The draft after the user picks a different action type: email fields survive only for send_email. */
export function draftForActionType(current: WorkflowDraft, actionType: InsertableActionType): WorkflowDraft {
  const email = actionType === 'send_email'
  return {
    ...current,
    actionType,
    connectionId: email ? current.connectionId : '',
    to: email ? current.to : '',
    subject: email ? current.subject : { parts: [] },
    body: email ? current.body : { parts: [] },
    addRecord: actionType === 'add_record' ? current.addRecord || { targetTableId: '', fields: [] } : undefined,
    updateRecord: actionType === 'update_record' ? current.updateRecord || { target: 'trigger_record', fields: [] } : undefined,
    lookupRecord: actionType === 'lookup_record' ? current.lookupRecord || { targetTableId: '', matchFieldId: '', matchValue: { parts: [] }, writeBack: [] } : undefined,
    transformRecord: actionType === 'transform_record' ? current.transformRecord || { operations: [] } : undefined,
  }
}

function newFilterNodeId() {
  return `filter_${Date.now().toString(36)}`
}

export function createFilterGraphNode(nodeId = newFilterNodeId()): GraphNode {
  return { nodeId, kind: 'filter', config: { nodeId, type: 'filter', expression: '', mode: 'all' } }
}

export function cloneFilterGraphNode(node: GraphNode, nodeId = newFilterNodeId()): GraphNode {
  return { ...node, nodeId, config: { ...node.config, nodeId } }
}

/** A blank row shaped like the trigger table, used to dry-run a filter expression. */
export function filterDryRunSample(schema: TableSchema | undefined): Record<string, unknown> {
  const sample: Record<string, unknown> = {}
  for (const field of schema?.fields || []) {
    sample[field.name] = field.type === 'number' ? 0 : ''
  }
  return sample
}

export type TriggerTableOption = { tableId: string; tableName: string; documentTitle: string }

/**
 * Tables the trigger picker offers, sorted by document then table. Inside a
 * .kitable scope only that document's tables show, plus the currently bound
 * table so an out-of-scope binding still renders as selected.
 */
export function buildTriggerTableOptions(
  tableLabels: Record<string, TableLabel>,
  scopedKitablePath: string | undefined,
  currentTableId: string,
): TriggerTableOption[] {
  return Object.entries(tableLabels)
    .filter(([tableId, label]) => !scopedKitablePath || tableId === currentTableId || label.documentPath === scopedKitablePath)
    .map(([tableId, label]) => ({ tableId, tableName: label.tableName, documentTitle: label.documentTitle }))
    .sort((a, b) => a.documentTitle.localeCompare(b.documentTitle) || a.tableName.localeCompare(b.tableName))
}

export type RunStatusCounts = { all: number; ok: number; error: number; skipped: number }

export function countRunsByStatus(runs: readonly WorkflowRunRecord[]): RunStatusCounts {
  return {
    all: runs.length,
    ok: runs.filter((run) => run.status === 'ok').length,
    error: runs.filter((run) => run.status === 'error').length,
    skipped: runs.filter((run) => run.status === 'skipped').length,
  }
}
