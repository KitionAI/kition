import request from '@/api/request'
import type { BodyTemplate } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { WORKFLOW_CHANGED_EVENT } from '@/features/workflow/lib/workflowEvents'

export { WORKFLOW_CHANGED_EVENT } from '@/features/workflow/lib/workflowEvents'

export type WorkflowNodeKind = 'trigger' | 'action' | 'filter'

export type WorkflowNode = {
  nodeId: string
  kind: WorkflowNodeKind
  config: Record<string, unknown>
}

export type WorkflowEdge = {
  from: string
  to: string
  branch?: 'yes' | 'no' | ''
}

/** WorkflowAddRecordConfig mirrors the Go AddRecordConfig payload. Target
 *  document/table identify where the new row gets written; fields binds the
 *  target table's field IDs to BodyTemplate values (so trigger output can be
 *  templated into cells the same way send_email subjects/bodies are). */
export type WorkflowAddRecordConfig = {
  targetDocumentId?: string
  targetTableId: string
  fields: { fieldId: string; value: BodyTemplate }[]
}

export type WorkflowUpdateRecordConfig = {
  target: 'trigger_record'
  fields: { fieldId: string; value: BodyTemplate }[]
}

export type WorkflowLookupRecordConfig = {
  targetDocumentId?: string
  targetTableId: string
  matchFieldId: string
  matchValue: BodyTemplate
  writeBack: { sourceFieldId: string; targetFieldId: string }[]
}

export type WorkflowTransformOperation = {
  source: BodyTemplate
  operation: 'trim' | 'lowercase' | 'uppercase' | 'digits_only' | 'domain_from_email' | 'concat' | 'number_add' | 'number_multiply'
  argument?: string
  targetFieldId: string
}

export type WorkflowTransformRecordConfig = {
  operations: WorkflowTransformOperation[]
}

export type WorkflowDefinition = {
  id: string
  name: string
  description: string
  enabled: boolean
  schemaVer?: number
  trigger: {
    nodeId: string
    type: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'scheduled_time' | 'record_date_reached' | string
    documentId?: string
    tableId: string
    /** Only populated when type === 'scheduled_time'. Mirrors the Go
     *  TriggerConfig.Schedule struct: cron is a 5-field expression,
     *  timezone is an IANA name that anchors when "9am" actually fires
     *  (empty = server local time). Empty/missing cron means the workflow
     *  is a scheduled draft that won't fire until the user picks a
     *  recurrence. */
    schedule?: {
      cron?: string
      timezone?: string
    }
    /** Only populated when type === 'record_date_reached'. Mirrors the Go
     *  TriggerConfig.DateField struct: fieldId names the date column on the
     *  bound table; atTime is HH:MM in 24h notation (omitted means "server
     *  default", today 09:00). */
    dateField?: {
      fieldId: string
      atTime?: string
    }
    /** Field IDs that must be non-empty on the trigger record for the
     *  workflow to fire. Empty / omitted disables the gate (every record
     *  fires). Mirrors the Feishu "And the selected field is not empty"
     *  pattern. Only meaningful for record-bearing trigger types
     *  (record_created / record_updated / record_created_or_updated /
     *  record_date_reached) — schema validator rejects unknown field IDs;
     *  numeric 0 and boolean false count as non-empty (see Go
     *  IsFieldValueEmpty for the truth table). */
    requiredFields?: string[]
  }
  action: {
    nodeId: string
    type: 'send_email' | 'add_record' | 'send_notification' | 'update_record' | 'lookup_record' | 'transform_record' | string
    connectionId?: string
    to: string
    /** Subject is a BodyTemplate so the user can insert trigger-field
     *  tokens the same way the body does. The backend accepts both the
     *  new {parts:[...]} shape AND the legacy plain string for
     *  back-compat with workflow.json files written before this change;
     *  this client always sends the BodyTemplate form. */
    subject: BodyTemplate
    /** Notification-only banner title (send_notification). Empty for other
     *  action types — kept on the union for shape consistency. */
    title?: string
    body: BodyTemplate
    /** Only populated when type === 'add_record'. Carries the target table
     *  + per-field BodyTemplate values used to materialise the new row. */
    addRecord?: WorkflowAddRecordConfig
    updateRecord?: WorkflowUpdateRecordConfig
    lookupRecord?: WorkflowLookupRecordConfig
    transformRecord?: WorkflowTransformRecordConfig
  }
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

export type WorkflowPatch = {
  name?: string
  description?: string
  enabled?: boolean
  /** Partial trigger update. The drawer's "Select table" dropdown lands
   *  here — it changes documentId / tableId in place without invalidating
   *  the rest of the workflow. Backend tolerates partial fields: any
   *  omitted key keeps its existing value. */
  trigger?: {
    nodeId?: string
    type?: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'scheduled_time' | 'record_date_reached' | ''
    documentId?: string
    tableId?: string
    /** Replaces the stored schedule wholesale when present. Sent by the
     *  trigger properties drawer when the user picks/changes a cron
     *  expression or timezone for a scheduled_time trigger. */
    schedule?: {
      cron?: string
      timezone?: string
    }
    /** Replaces the stored dateField wholesale when present. Sent by the
     *  trigger properties drawer when the user picks a date column / time
     *  for a record_date_reached trigger. */
    dateField?: {
      fieldId: string
      atTime?: string
    }
    /** Replaces the stored requiredFields list. Pointer-style semantics on
     *  the server: omit/undefined leaves the gate untouched, [] clears it,
     *  [...] replaces. The drawer's "Required fields" panel sends this on
     *  every checkbox toggle. */
    requiredFields?: string[]
  }
  action?: {
    type?: 'send_email' | 'add_record' | 'send_notification' | 'update_record' | 'lookup_record' | 'transform_record' | ''
    connectionId?: string
    to?: string
    subject?: BodyTemplate
    title?: string
    body?: BodyTemplate
    /** Replaces the stored addRecord block wholesale when present. Used by
     *  the action properties drawer when the user edits an add_record
     *  action's target table / per-field templates. */
    addRecord?: WorkflowAddRecordConfig
    updateRecord?: WorkflowUpdateRecordConfig
    lookupRecord?: WorkflowLookupRecordConfig
    transformRecord?: WorkflowTransformRecordConfig
  }
  // v2 multi-node patch. When present, the server treats nodes/edges as
  // authoritative for the non-trigger/action nodes (filters etc.) — the
  // trigger and primary action are still derived from the action: field
  // for v1 compat.
  nodes?: WorkflowNode[]
  edges?: WorkflowEdge[]
}

export type NodeIssue = {
  nodeId: string
  code: string
  message: string
  hint?: string
  /** "error" blocks Save; "warning" is advisory (yellow chip in the UI,
   *  Save still allowed). Omitted on legacy server responses; callers
   *  should default to "error" so behavior degrades safely. */
  level?: 'error' | 'warning'
}

function unwrapWorkflow(response: WorkflowDefinition | { workflow?: WorkflowDefinition }) {
  return (response as { workflow?: WorkflowDefinition }).workflow ?? (response as WorkflowDefinition)
}

/** kition:workflow:changed broadcasts that any workflow save/delete
 *  has completed. WorkspaceScreen listens to keep the file-tree
 *  Workflows(n) badge in lockstep with the list.
 *
 *  We dispatch from the API layer (rather than each caller) so any future
 *  consumer that calls patchWorkflow/deleteWorkflow gets the refresh
 *  for free. The event carries the operation + id so listeners can be
 *  selective if they want. */
function emitWorkflowChanged(op: 'patch' | 'delete', workflowId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKFLOW_CHANGED_EVENT, { detail: { op, workflowId } }))
}

export type CreateWorkflowInput = {
  name: string
  description: string
  enabled: boolean
  trigger: {
    // Mirrors WorkflowDefinition.trigger.type — the server already accepts
    // record_updated / record_created_or_updated, but until now the create
    // payload type narrowed those out, so templates couldn't express them.
    // record_date_reached is the "At record's trigger time" template path:
    // we create the workflow with only the type set, then the user fills in
    // the date-field reference via the trigger node's properties drawer
    // (delayed binding). scheduled_time is the Feishu "At scheduled time"
    // template path: the trigger carries a cron expression instead of a
    // table binding (TableID stays empty by design). Empty string '' is
    // allowed for draft workflows (delayed binding): the server's
    // Validate() tolerates empty type/documentId/tableId when Enabled=false,
    // so the UI can start a workflow without binding a table.
    type: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'scheduled_time' | 'record_date_reached' | ''
    documentId: string
    tableId: string
    requiredFields?: string[]
    /** Only populated when type === 'scheduled_time'. Carries the initial
     *  cron expression and timezone so a template can ship a complete,
     *  runnable workflow (e.g. "0 11 * * *" in "Asia/Shanghai" → every
     *  day at 11:00 Shanghai time). */
    schedule?: {
      cron?: string
      timezone?: string
    }
  }
  action: {
    type: 'send_email' | 'add_record' | 'send_notification' | 'update_record' | 'lookup_record' | 'transform_record'
    connectionId: string
    to: string
    subject: BodyTemplate
    body: BodyTemplate
    /** Only populated when type === 'add_record'. Carries the target table
     *  + per-field BodyTemplate values so a template like "Add a record at
     *  11am daily" can ship pre-bound to the same table the user just
     *  picked. */
    addRecord?: WorkflowAddRecordConfig
    updateRecord?: WorkflowUpdateRecordConfig
    lookupRecord?: WorkflowLookupRecordConfig
    transformRecord?: WorkflowTransformRecordConfig
  }
}

export function createWorkflow(input: CreateWorkflowInput) {
  return request
    .post<WorkflowDefinition | { workflow?: WorkflowDefinition }>('/v1/workflows', input)
    .then((response) => {
      const def = unwrapWorkflow(response)
      emitWorkflowChanged('patch', def.id)
      return def
    })
}

export function listWorkflows() {
  return request
    .get<{ items?: WorkflowDefinition[] }>('/v1/workflows')
    .then((response) => response.items || [])
}

export function patchWorkflow(workflowId: string, patch: WorkflowPatch) {
  return request
    .patch<WorkflowDefinition | { workflow?: WorkflowDefinition }>(`/v1/workflows/${workflowId}`, patch)
    .then((response) => {
      const out = unwrapWorkflow(response)
      emitWorkflowChanged('patch', workflowId)
      return out
    })
}

export function deleteWorkflow(workflowId: string) {
  return request.delete<{ ok?: boolean }>(`/v1/workflows/${workflowId}`).then((response) => {
    emitWorkflowChanged('delete', workflowId)
    return response
  })
}

export function listWorkflowRuns(workflowId: string, limit = 50, status?: string) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (status && status !== 'all') params.set('status', status)
  return request
    .get<{ runs?: WorkflowRunRecord[] }>(`/v1/workflows/${workflowId}/runs?${params.toString()}`)
    .then((response) => response.runs || [])
}

// retryWorkflowRun re-executes a stored run. Server appends a new run row
// (status ok|error) with the same trigger event and record id as the
// original; the UI typically optimistically inserts it at row 0.
export function retryWorkflowRun(workflowId: string, runId: string) {
  return request
    .post<{ run?: WorkflowRunRecord }>(`/v1/workflows/${workflowId}/runs/${runId}/retry`, {})
    .then((response) => response.run || null)
}

export type FilterDryRunResult = {
  ok: boolean
  matched?: boolean
  parseError?: string
  evalError?: string
}

// dryRunFilter evaluates a filter expression against a synthetic sample
// payload. UI calls this from the filter properties panel to show the
// user whether the current condition would let a given row through.
export function dryRunFilter(
  workflowId: string,
  expression: string,
  sample: Record<string, unknown>,
  triggerNode = 'trigger_1',
) {
  return request.post<FilterDryRunResult>(
    `/v1/workflows/${workflowId}/filters/dry-run`,
    { expression, sample, triggerNode },
  )
}

// validateWorkflow returns per-node diagnostics; render them as red dots
// next to the offending node. Wrapped in {issues:[]} server-side so
// future fields (severity, etc.) can be added without breaking callers.
//
// Optional `patch` carries the user's in-progress draft. The server
// projects it over the stored definition in memory (no persistence) before
// validating, so the canvas reflects unsaved edits instead of the
// last-saved snapshot. Without this the user types a recipient, validation
// re-runs, but the server still reports "Recipient is required" against
// the empty-on-disk To field and the node stays red.
export function validateWorkflow(workflowId: string, patch?: WorkflowPatch) {
  return request
    .post<{ issues?: NodeIssue[] }>(`/v1/workflows/${workflowId}/validate`, patch ?? {})
    .then((response) => response.issues || [])
}

// testWorkflowNode runs the per-node test path. send_email delivers a real
// test message; add_record executes the real action and returns the created
// record metadata; trigger nodes return a no-op success.
export function testWorkflowNode(
	workflowId: string,
	nodeId: string,
	body?: { to?: string; triggerFields?: Record<string, unknown>; recordId?: string },
) {
  return request.post<{
    ok?: boolean
    skipped?: string
    input?: { to: string; subject: string; body: string }
    output?: { recordId?: string; tableId?: string; documentId?: string; values?: Record<string, unknown>; matched?: boolean; changed?: boolean; matchedRecordId?: string }
    error?: string
  }>(
    `/v1/workflows/${workflowId}/nodes/${nodeId}/test`,
    body || {},
  )
}

// listWorkflowsForTable powers the file-tree virtual node — given a
// tableId, returns workflows whose trigger references it.
export function listWorkflowsForTable(tableId: string) {
  return request
    .get<{ items?: WorkflowDefinition[] }>(`/v1/tables/${tableId}/workflows`)
    .then((response) => response.items || [])
}

// previewSchedule asks the server for the next 3 fire times for a (cron, tz)
// pair without persisting anything. The drawer calls it on debounce when the
// user edits a scheduled trigger so they see "Next: tomorrow 09:00 …" before
// hitting Save. ISO-8601 UTC strings come back; the caller localises with
// Intl.DateTimeFormat for the user's clock.
//
// Errors come through as the request-layer rejection (4xx body has
// { error: string }). The hook around this catches them and surfaces a
// caption rather than letting the panel crash on a bad cron mid-edit.
export interface SchedulePreviewResponse {
  nextRuns: string[]
  timezone: string
}
export function previewSchedule(cron: string, timezone: string) {
  const params = new URLSearchParams({ cron })
  if (timezone) params.set('tz', timezone)
  return request.get<SchedulePreviewResponse>(
    `/v1/workflows/_preview/schedule?${params.toString()}`,
  )
}
