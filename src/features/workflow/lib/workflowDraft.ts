import type {
  ConnectionView,
} from '@/features/connections/api'
import type { NodeStatus } from '@/features/workflow/canvas/NodeCard'
import type {
  BodyPart,
  BodyTemplate,
  TableSchema,
} from '@/features/workflow/components/BodyTemplateEditor.types'
import type {
  WorkflowAddRecordConfig,
  WorkflowLookupRecordConfig,
  WorkflowTransformRecordConfig,
  WorkflowUpdateRecordConfig,
  WorkflowDefinition,
  WorkflowPatch,
} from '@/features/workflow/api'
import type { GraphNode } from '@/features/workflow/hooks/useWorkflowGraph'
import type { WorkflowRunRecord } from '@/features/workflow/hooks/useWorkflowRuns'
import { STREAMING_WORKFLOW_ID } from '@/features/workflow/lib/aiBuildPreview'

/**
 * Pure helpers extracted out of WorkflowHomePage as part of WF-C1. Keeping
 * them in their own file means:
 *   - the spec files can import them directly instead of pulling the page
 *     module (and its 2k+ lines of incidental React state) into the test
 *     environment;
 *   - future refactors that split WorkflowHomePage further don't drag the
 *     helpers around — they live where the helpers semantically belong
 *     (draft shape + canvas/node derivations), not where they happened to
 *     be authored;
 *   - the WorkflowHomePage file itself shrinks by ~250 lines, which makes
 *     the remaining god-component logic easier to read at a glance.
 *
 * Every function here is referentially transparent — no React, no side
 * effects, no environment access. That's the contract: if you find
 * yourself wanting to reach for useState here, put the helper back into
 * WorkflowHomePage or pull a new hook into ../hooks/.
 */

// ─── draft shape ──────────────────────────────────────────────────────────

export type WorkflowDraft = {
  name: string
  description: string
  /** Mirrors the selected workflow's action.type. Drives which fields the
   *  drawer renders + which validation rules apply at Save time. */
  actionType: 'send_email' | 'add_record' | 'send_notification' | string
  // ─── send_email-specific draft fields ──────────────────────────────────
  connectionId: string
  to: string
  subject: BodyTemplate
  body: BodyTemplate
  // ─── add_record-specific draft fields ──────────────────────────────────
  /** Populated only when actionType === 'add_record'. Cloned on toDraft so
   *  edits stay local until Save. */
  addRecord?: WorkflowAddRecordConfig
  updateRecord?: WorkflowUpdateRecordConfig
  lookupRecord?: WorkflowLookupRecordConfig
  transformRecord?: WorkflowTransformRecordConfig
}

export type TableLabel = {
  tableName: string
  documentTitle: string
  /** The data-doc path the table belongs to. Required so the trigger
   *  panel can rebind both documentId and tableId in a single edit
   *  (the backend's trigger config is `{documentId, tableId, type}`). */
  documentId: string
  /** Filesystem path of the owning document (e.g. `t2.kitable`). Used by
   *  the trigger Table picker to constrain choices to the kitable scope
   *  the workflow was created under. */
  documentPath: string
}

export function resolveWorkflowKitablePath(
  workflow: WorkflowDefinition,
  labels: Record<string, TableLabel>,
): string {
  const documentIds = [
    workflow.trigger?.documentId,
    workflow.action?.addRecord?.targetDocumentId,
    workflow.action?.lookupRecord?.targetDocumentId,
  ].map((value) => String(value || '').trim()).filter(Boolean)

  for (const documentId of documentIds) {
    const label = Object.values(labels).find((item) => item.documentId === documentId)
    if (label?.documentPath) return label.documentPath
  }

  const tableIds = [
    workflow.trigger?.tableId,
    workflow.action?.addRecord?.targetTableId,
    workflow.action?.lookupRecord?.targetTableId,
  ].map((value) => String(value || '').trim()).filter(Boolean)

  for (const tableId of tableIds) {
    const documentPath = labels[tableId]?.documentPath
    if (documentPath) return documentPath
  }

  return ''
}

/** ValidationErrors values are STABLE CODES, not display strings — pass them
 *  through `formatValidationCode` (or build the key inline) to render. The
 *  codes match the i18n keys under `panels.home.validation.*`. */
export type ValidationErrors = {
  name?: string
  /** send_email validation. */
  to?: string
  subject?: string
  body?: string
  /** add_record validation — surfaced next to the target-table picker. */
  addRecordTarget?: string
  recordAction?: string
}

/** formatValidationCode maps a validation code (e.g. `'recipientRequired'`)
 *  to the locale-appropriate message via i18n. Returns the raw code when no
 *  translator is supplied so unit tests don't have to wire one up. */
export function formatValidationCode(code: string | undefined, t?: (key: string) => string): string {
  if (!code) return ''
  if (!t) return code
  return t(`panels.home.validation.${code}`)
}

export function emptyDraft(): WorkflowDraft {
  return { name: '', description: '', actionType: 'send_email', connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] } }
}

export function toDraft(workflow: WorkflowDefinition): WorkflowDraft {
  const actionType = workflow.action.type || 'send_email'
  return {
    name: workflow.name || '',
    description: workflow.description || '',
    actionType,
    connectionId: workflow.action.connectionId || '',
    to: workflow.action.to || '',
    subject: coerceSubjectToTemplate(workflow.action.subject),
    body: cloneBody(workflow.action.body),
    addRecord: actionType === 'add_record' && workflow.action.addRecord
      ? cloneAddRecord(workflow.action.addRecord)
      : undefined,
    updateRecord: actionType === 'update_record' && workflow.action.updateRecord
      ? cloneUpdateRecord(workflow.action.updateRecord)
      : undefined,
    lookupRecord: actionType === 'lookup_record' && workflow.action.lookupRecord
      ? cloneLookupRecord(workflow.action.lookupRecord)
      : undefined,
    transformRecord: actionType === 'transform_record' && workflow.action.transformRecord
      ? cloneTransformRecord(workflow.action.transformRecord)
      : undefined,
  }
}

// coerceSubjectToTemplate accepts both the new BodyTemplate shape AND
// the legacy plain-string shape the backend used to send (and that
// older saved workflows on disk may still carry until they round-trip
// through a save). Strings become single-text-part templates so the
// rest of the draft pipeline doesn't have to know.
export function coerceSubjectToTemplate(value: unknown): BodyTemplate {
  if (typeof value === 'string') {
    return value ? { parts: [{ kind: 'text', text: value }] } : { parts: [] }
  }
  if (value && typeof value === 'object' && Array.isArray((value as BodyTemplate).parts)) {
    return cloneBody(value as BodyTemplate)
  }
  return { parts: [] }
}

export function cloneBody(body: BodyTemplate): BodyTemplate {
  return { parts: (body.parts || []).map((part) => {
    if (part.kind === 'field_ref') {
      return { kind: 'field_ref', fieldRef: { ...part.fieldRef } }
    }
    if (part.kind === 'text') {
      return { kind: 'text', text: part.text }
    }
    return { kind: 'newline' }
  }) }
}

/** cloneAddRecord deep-copies the add_record config so per-row body edits in
 *  the draft don't mutate the workflow's saved state by reference. The
 *  fields array is rebuilt; each value BodyTemplate is round-tripped through
 *  cloneBody so it gets the same structural-clone treatment the send_email
 *  body relies on. */
export function cloneAddRecord(config: WorkflowAddRecordConfig): WorkflowAddRecordConfig {
  return {
    targetDocumentId: config.targetDocumentId,
    targetTableId: config.targetTableId,
    fields: (config.fields || []).map((entry) => ({
      fieldId: entry.fieldId,
      value: cloneBody(entry.value),
    })),
  }
}

export function cloneUpdateRecord(config: WorkflowUpdateRecordConfig): WorkflowUpdateRecordConfig {
  return {
    target: 'trigger_record',
    fields: config.fields.map((entry) => ({ fieldId: entry.fieldId, value: cloneBody(entry.value) })),
  }
}

export function cloneLookupRecord(config: WorkflowLookupRecordConfig): WorkflowLookupRecordConfig {
  return {
    targetDocumentId: config.targetDocumentId,
    targetTableId: config.targetTableId,
    matchFieldId: config.matchFieldId,
    matchValue: cloneBody(config.matchValue),
    writeBack: config.writeBack.map((entry) => ({ ...entry })),
  }
}

export function cloneTransformRecord(config: WorkflowTransformRecordConfig): WorkflowTransformRecordConfig {
  return {
    operations: config.operations.map((operation) => ({
      ...operation,
      source: cloneBody(operation.source),
    })),
  }
}

export function draftsEqual(a: WorkflowDraft, b: WorkflowDraft): boolean {
  return a.name === b.name
    && a.description === b.description
    && a.actionType === b.actionType
    && a.connectionId === b.connectionId
    && a.to === b.to
    && JSON.stringify(a.subject) === JSON.stringify(b.subject)
    && JSON.stringify(a.body) === JSON.stringify(b.body)
    && JSON.stringify(a.addRecord || null) === JSON.stringify(b.addRecord || null)
    && JSON.stringify(a.updateRecord || null) === JSON.stringify(b.updateRecord || null)
    && JSON.stringify(a.lookupRecord || null) === JSON.stringify(b.lookupRecord || null)
    && JSON.stringify(a.transformRecord || null) === JSON.stringify(b.transformRecord || null)
}

export function changedFields(a: WorkflowDraft, b: WorkflowDraft): string[] {
  const fields: string[] = []
  if (a.name !== b.name) fields.push('Name')
  if (a.description !== b.description) fields.push('Description')
  if (a.actionType !== b.actionType) fields.push('Action type')
  if (a.connectionId !== b.connectionId) fields.push('Connection')
  if (a.to !== b.to) fields.push('To')
  if (JSON.stringify(a.subject) !== JSON.stringify(b.subject)) fields.push('Subject')
  if (JSON.stringify(a.body) !== JSON.stringify(b.body)) fields.push('Body')
  if (JSON.stringify(a.addRecord || null) !== JSON.stringify(b.addRecord || null)) fields.push('Add record')
  if (JSON.stringify(a.updateRecord || null) !== JSON.stringify(b.updateRecord || null)) fields.push('Update record')
  if (JSON.stringify(a.lookupRecord || null) !== JSON.stringify(b.lookupRecord || null)) fields.push('Lookup record')
  if (JSON.stringify(a.transformRecord || null) !== JSON.stringify(b.transformRecord || null)) fields.push('Transform record')
  return fields
}

/** validateDraft returns stable error codes (not display strings) so the
 *  same draft can be rendered in any locale. Consumers translate via
 *  `t('panels.home.validation.<code>')`. The codes mirror the server-side
 *  validation issue codes to keep the wire and the UI vocabulary aligned. */
export function validateDraft(draft: WorkflowDraft): ValidationErrors {
  const errors: ValidationErrors = {}
  if (!draft.name.trim()) errors.name = 'nameRequired'
  if (draft.actionType === 'add_record') {
    if (!draft.addRecord?.targetTableId) {
      errors.addRecordTarget = 'addRecordTargetRequired'
    }
    // We deliberately don't require fields to be populated client-side —
    // the backend permits an "all defaults" add_record and surfaces
    // diagnostics when individual field bindings are wrong. Letting the
    // server own that rule keeps the UI from drifting if the backend's
    // contract changes.
    return errors
  }
  if (draft.actionType === 'update_record') {
    if (!draft.updateRecord?.fields.length) errors.recordAction = 'updateRecordFieldsRequired'
    return errors
  }
  if (draft.actionType === 'lookup_record') {
    if (!draft.lookupRecord?.targetTableId || !draft.lookupRecord.matchFieldId || !draft.lookupRecord.writeBack.length) {
      errors.recordAction = 'lookupRecordConfigRequired'
    }
    return errors
  }
  if (draft.actionType === 'transform_record') {
    if (!draft.transformRecord?.operations.length) errors.recordAction = 'transformRecordOperationsRequired'
    return errors
  }
  // send_email (and any other text-message-style action — only send_email
  // exists today; send_notification reuses the same fields).
  const to = draft.to.trim()
  if (!to) {
    errors.to = 'recipientRequired'
  } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    errors.to = 'recipientInvalid'
  }
  if (!subjectIsNonEmpty(draft.subject)) errors.subject = 'subjectRequired'
  if (!draft.body.parts.length) errors.body = 'bodyRequired'
  return errors
}

// subjectIsNonEmpty mirrors the backend SubjectIsEmpty contract: a
// template is "empty" iff it has no field_ref part and every text part
// trims to empty. Used by the validator and by the dirty/preview helpers
// that previously compared the legacy string field with a !== '' check.
export function subjectIsNonEmpty(subject: BodyTemplate): boolean {
  for (const part of subject.parts || []) {
    if (part.kind === 'field_ref') return true
    if (part.kind === 'text' && part.text.trim()) return true
  }
  return false
}

/** draftToValidationPatch projects the user's in-progress draft into the
 *  WorkflowPatch shape the server's /validate endpoint accepts. Used by
 *  useWorkflowValidation so the server-side rules (RFC-5322 To, connection
 *  health, graph cycles) run against what the user is currently editing
 *  instead of the last-saved snapshot. The trigger isn't covered because
 *  the draft state doesn't track trigger fields — trigger edits route
 *  through the trigger panel's own patch path and are saved immediately,
 *  not via the SaveBar. Mirrors the Save handler's actionPatch shape so a
 *  draft that validates cleanly here will also validate after Save.
 *
 *  When `originalAction` is supplied (the workflow's saved action snapshot)
 *  we forward `type`/`addRecord` even when the draft doesn't override them
 *  — the backend's ActionPatch is leaf-pointer-merge, so omitting them
 *  would let stale fields from the stored def slip past validation. */
export function draftToValidationPatch(
  draft: WorkflowDraft,
  originalAction?: WorkflowDefinition['action'],
): WorkflowPatch {
  if (draft.actionType === 'add_record') {
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      action: {
        type: 'add_record',
        addRecord: draft.addRecord,
      },
    }
  }
  if (draft.actionType === 'update_record') {
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      action: { type: 'update_record', updateRecord: draft.updateRecord },
    }
  }
  if (draft.actionType === 'lookup_record') {
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      action: { type: 'lookup_record', lookupRecord: draft.lookupRecord },
    }
  }
  if (draft.actionType === 'transform_record') {
    return {
      name: draft.name.trim(),
      description: draft.description.trim(),
      action: { type: 'transform_record', transformRecord: draft.transformRecord },
    }
  }
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    action: {
      type: (originalAction?.type as 'send_email' | 'send_notification' | undefined) ?? 'send_email',
      connectionId: draft.connectionId,
      to: draft.to.trim(),
      subject: draft.subject,
      body: cloneBody(draft.body),
    },
  }
}

// ─── body field-ref helpers ───────────────────────────────────────────────

/** findDanglingFieldRefs returns the field IDs in `body` that don't exist on
 *  `schema`. Used to count and prune stale references when the trigger
 *  table changes underneath an existing body template. Returns an empty
 *  list when body has no parts or schema is empty — the caller treats that
 *  the same as "no warning needed". */
export function findDanglingFieldRefs(body: BodyTemplate, schema: TableSchema): string[] {
  const known = new Set<string>(schema.fields.map((f) => f.id))
  const out: string[] = []
  for (const part of body.parts || []) {
    if (part.kind === 'field_ref' && !known.has(part.fieldRef.fieldId)) {
      out.push(part.fieldRef.fieldId)
    }
  }
  return out
}

/** pruneBody returns a copy of `body` with all field_refs whose fieldId is
 *  in `removeFieldIds` dropped. Text and newline parts are preserved as-is
 *  so the surrounding prose stays intact — the user only loses the broken
 *  bindings. Symmetrical with cloneBody so the caller can hand the result
 *  straight to patchWorkflow without further normalisation. */
export function pruneBody(body: BodyTemplate, removeFieldIds: string[]): BodyTemplate {
  const drop = new Set<string>(removeFieldIds)
  const next: BodyPart[] = []
  for (const part of body.parts || []) {
    if (part.kind === 'field_ref' && drop.has(part.fieldRef.fieldId)) continue
    if (part.kind === 'field_ref') {
      next.push({ kind: 'field_ref', fieldRef: { ...part.fieldRef } })
    } else if (part.kind === 'text') {
      next.push({ kind: 'text', text: part.text })
    } else {
      next.push({ kind: 'newline' })
    }
  }
  return { parts: next }
}

// ─── id parsing + graph helpers ──────────────────────────────────────────

/** parseIdAsNumber converts the workflow's string-typed documentId / tableId
 *  into the numeric form the data-documents API expects. Empty strings or
 *  non-numeric values produce null so the caller (SampleRowPicker) can
 *  gracefully render its "no binding yet" state instead of fetching with
 *  NaN. Exported only for the spec — keep the contract pinned so a future
 *  numeric-ID schema change is caught by the test rather than blowing up
 *  the picker silently. */
export function parseIdAsNumber(raw: string | undefined): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** graphNodesEqual short-circuits on length and structural diffs before
 *  falling back to a deep JSON compare on the per-node config object. The
 *  goal is to skip the double JSON.stringify of the whole array on every
 *  render — the common edit cycle (toggle a filter's mode, type into a
 *  condition value) walks all nodes but never serialises the unchanged
 *  ones. Config is `Record<string, unknown>` so we still need a deep
 *  compare for FilterConfig's nested conditions[], but it's now per-node
 *  and bails early on the first mismatch.
 *
 *  Exported only for the spec — keep the dirty-detection contract pinned
 *  so a future refactor of graph mutations can't silently break it. */
export function graphNodesEqual(a: GraphNode[], b: GraphNode[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.nodeId !== y.nodeId) return false
    if (x.kind !== y.kind) return false
    if ((x.disabled || false) !== (y.disabled || false)) return false
    if (!configEqual(x.config, y.config)) return false
  }
  return true
}

/** configEqual deep-compares two `Record<string, unknown>` config payloads
 *  by re-using JSON.stringify on each side. Pulled out of graphNodesEqual
 *  so the comparator is a no-op when the per-node fields already match,
 *  which is the bulk of the cost on a long filter chain. */
function configEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

// ─── workflow / canvas derivations ───────────────────────────────────────

export function workflowStatus(workflow: WorkflowDefinition, latestRun: WorkflowRunRecord | null): 'on' | 'off' | 'error' | 'streaming' {
  if (workflow.id === STREAMING_WORKFLOW_ID) return 'streaming'
  if (latestRun?.status === 'error') return 'error'
  return workflow.enabled ? 'on' : 'off'
}

export function triggerLabel(
  workflow: WorkflowDefinition,
  labels: Record<string, TableLabel>,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const tx = t || ((_k: string, opts?: Record<string, unknown>) => (opts?.fallback as string) || _k)
  // scheduled_time has no table binding — the trigger source is a clock,
  // so we surface the cron expression (or a "(no schedule)" placeholder)
  // in the same slot the row-event triggers use for the table name. This
  // keeps the FlowLine / WorkflowCanvas trigger label readable instead of
  // showing "Record created · Unknown table" for every scheduled workflow.
  if (workflow.trigger.type === 'scheduled_time') {
    const cron = (workflow.trigger.schedule?.cron || '').trim()
    const noSched = tx('panels.home.nodeCard.noSchedule', { fallback: '(no schedule)' })
    const verb = tx(triggerTitleI18nKey('scheduled_time'), { fallback: 'At scheduled time' })
    return `${verb} · ${cron || noSched}`
  }
  const tableId = workflow.trigger.tableId
  // Streaming preview: the trigger event hasn't arrived yet, so tableId is ''
  // and there's no label to look up. Render a neutral placeholder instead of
  // "Record created · Unknown table" so the list row reads as in-flight.
  if (!tableId) {
    const verb = tx(triggerVerbI18nKey(workflow.trigger.type), { fallback: triggerVerb(workflow.trigger.type) })
    return `${verb} · —`
  }
  const label = labels[tableId]
  const verb = tx(triggerVerbI18nKey(workflow.trigger.type), { fallback: triggerVerb(workflow.trigger.type) })
  if (!label) return `${verb} · ${tx('panels.home.nodeCard.unknownTable', { fallback: 'Unknown table' })}`
  return `${verb} · ${label.tableName}`
}

function triggerVerb(type: WorkflowDefinition['trigger']['type']): string {
  switch (type) {
    case 'record_updated': return 'Record updated'
    case 'record_created_or_updated': return 'Record created or updated'
    case 'record_date_reached': return 'Record date reached'
    default: return 'Record created'
  }
}

/** i18n key under `panels.drawer.titles.*` for the trigger node's title in
 *  the canvas card and the properties drawer. Centralised so both render
 *  sites stay in sync when a new trigger type lands. */
export function triggerTitleI18nKey(type: WorkflowDefinition['trigger']['type']): string {
  switch (type) {
    case 'record_updated': return 'panels.drawer.titles.whenRecordUpdated'
    case 'record_created_or_updated': return 'panels.drawer.titles.whenRecordCreatedOrUpdated'
    case 'record_date_reached': return 'panels.drawer.titles.whenRecordDateReached'
    case 'scheduled_time': return 'panels.drawer.titles.whenScheduledTime'
    default: return 'panels.drawer.titles.whenRecordCreated'
  }
}

/** i18n key under `panels.home.triggerVerb.*` for the compact verb shown in
 *  `triggerLabel()` (FlowLine "WHEN" rows and canvas trigger card
 *  subtitle). Separate from triggerTitleI18nKey so the noun-phrase title
 *  ("When a record is created") and the verb form ("Record created") can
 *  evolve independently. */
export function triggerVerbI18nKey(type: WorkflowDefinition['trigger']['type']): string {
  switch (type) {
    case 'record_updated': return 'panels.home.triggerVerb.recordUpdated'
    case 'record_created_or_updated': return 'panels.home.triggerVerb.recordCreatedOrUpdated'
    case 'record_date_reached': return 'panels.home.triggerVerb.recordDateReached'
    case 'scheduled_time': return 'panels.home.triggerVerb.scheduledTime'
    default: return 'panels.home.triggerVerb.recordCreated'
  }
}

// triggerStatus is intentionally conservative — the trigger is configured at
// build time and the user can't break it from the canvas (only via API).
// It only goes amber/red if the schema validation catches a missing table.
export function triggerStatus(workflow: WorkflowDefinition | null, validation: ValidationErrors): NodeStatus {
  if (!workflow) return 'muted'
  // scheduled_time has no table binding by design — the "red when no
  // tableId" heuristic would always fire, masking real issues. For
  // scheduled triggers we go red only when the cron string is missing
  // (validate.go enforces a non-empty cron when Enabled=true, so this
  // matches the server's blocking condition).
  if (workflow.trigger.type === 'scheduled_time') {
    const cron = (workflow.trigger.schedule?.cron || '').trim()
    if (!cron) return 'red'
    if (validation.name) return 'amber'
    return 'green'
  }
  if (!workflow.trigger.tableId) return 'red'
  if (validation.name) return 'amber'
  return 'green'
}

// actionStatus combines draft-side validation + the latest run signal so the
// node dot stays in lockstep with what the user can fix from the drawer.
export function actionStatus(
  draft: WorkflowDraft,
  validation: ValidationErrors,
  latestRun: WorkflowRunRecord | null,
): NodeStatus {
  if (latestRun?.status === 'error') return 'red'
  if (draft.actionType === 'add_record') {
    if (validation.addRecordTarget) return 'red'
    return 'green'
  }
  if (['update_record', 'lookup_record', 'transform_record'].includes(draft.actionType)) {
    return validation.recordAction ? 'red' : 'green'
  }
  if (validation.to || validation.subject || validation.body) return 'red'
  if (!draft.connectionId) return 'amber'
  return 'green'
}

export function actionInlineError({
  draft,
  validation,
  latestRun,
  t,
}: {
  draft: WorkflowDraft
  validation: ValidationErrors
  latestRun: WorkflowRunRecord | null
  /** i18n translator. Used to map the validation codes (e.g.
   *  `'recipientRequired'`) returned by validateDraft to the locale-appropriate
   *  message. Server-side `latestRun.error` is already a sentence — it falls
   *  through untouched. */
  t: (key: string) => string
}): { message: string } | null {
  if (latestRun?.status === 'error' && latestRun.error) {
    return { message: latestRun.error }
  }
  if (draft.actionType === 'add_record') {
    if (validation.addRecordTarget) return { message: t(`panels.home.validation.${validation.addRecordTarget}`) }
    return null
  }
  if (['update_record', 'lookup_record', 'transform_record'].includes(draft.actionType)) {
    return validation.recordAction ? { message: t(`panels.home.validation.${validation.recordAction}`) } : null
  }
  if (validation.to) return { message: t(`panels.home.validation.${validation.to}`) }
  if (validation.subject) return { message: t(`panels.home.validation.${validation.subject}`) }
  if (validation.body) return { message: t(`panels.home.validation.${validation.body}`) }
  if (!draft.connectionId) {
    return { message: t('panels.home.validation.connectionRequired') }
  }
  return null
}

export function actionNodeDescription(
  draft: WorkflowDraft,
  connections: ConnectionView[],
  tableLabels: Record<string, TableLabel>,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const tx = t || ((_k: string, opts?: Record<string, unknown>) => (opts?.fallback as string) || _k)
  if (draft.actionType === 'add_record') {
    const targetTableId = draft.addRecord?.targetTableId || ''
    const targetName = targetTableId ? tableLabels[targetTableId]?.tableName || targetTableId : tx('panels.home.nodeCard.noTarget', { fallback: 'no target' })
    const fieldCount = (draft.addRecord?.fields || []).length
    return tx('panels.home.nodeCard.addRecordDescription', { target: targetName, count: fieldCount, fallback: `into ${targetName} · ${fieldCount} field${fieldCount === 1 ? '' : 's'}` })
  }
  if (draft.actionType === 'update_record') {
    const count = draft.updateRecord?.fields.length || 0
    return tx('panels.home.nodeCard.updateRecordDescription', { count, fallback: `update trigger row · ${count} field${count === 1 ? '' : 's'}` })
  }
  if (draft.actionType === 'lookup_record') {
    const tableId = draft.lookupRecord?.targetTableId || ''
    const target = tableId ? tableLabels[tableId]?.tableName || tableId : tx('panels.home.nodeCard.noTarget', { fallback: 'no target' })
    return tx('panels.home.nodeCard.lookupRecordDescription', { target, fallback: `find a match in ${target} and fill this row` })
  }
  if (draft.actionType === 'transform_record') {
    const count = draft.transformRecord?.operations.length || 0
    return tx('panels.home.nodeCard.transformRecordDescription', { count, fallback: `${count} local transform${count === 1 ? '' : 's'}` })
  }
  const recipient = draft.to.trim() || tx('panels.home.nodeCard.noRecipient', { fallback: 'no recipient' })
  const connection = connections.find((c) => c.id === draft.connectionId)
  const channel = connection
    ? connection.name
    : draft.connectionId
      ? draft.connectionId
      : tx('panels.home.nodeCard.noConnectionSelected', { fallback: 'No connection selected' })
  return tx('panels.home.nodeCard.sendEmailDescription', { channel, recipient, fallback: `via ${channel} · to ${recipient}` })
}

export function actionTitleI18nKey(type: string): string {
  switch (type) {
    case 'add_record': return 'panels.home.nodeCard.actionAddRecord'
    case 'update_record': return 'panels.home.nodeCard.actionUpdateRecord'
    case 'lookup_record': return 'panels.home.nodeCard.actionLookupRecord'
    case 'transform_record': return 'panels.home.nodeCard.actionTransformRecord'
    default: return 'panels.home.nodeCard.actionSendEmail'
  }
}

// ─── filter helpers ───────────────────────────────────────────────────────

export function filterNodeTitle(node: GraphNode): string {
  const expression = String((node.config as { expression?: string })?.expression || '').trim()
  if (!expression) return 'New filter'
  // Try to render a short human label; first 40 chars of the expression is
  // usually clear enough ("priority == high").
  return expression.length > 40 ? expression.slice(0, 37) + '…' : expression
}

export function filterNodeDescription(node: GraphNode): string {
  const mode = ((node.config as { mode?: 'all' | 'any' })?.mode) || 'all'
  const expression = String((node.config as { expression?: string })?.expression || '').trim()
  if (!expression) return 'Configure the conditions for downstream actions'
  return `Match ${mode === 'any' ? 'any' : 'all'} · gate · true continues, false skips run`
}

export function filterNodeStatus(node: GraphNode): NodeStatus {
  if (node.disabled) return 'muted'
  const expression = String((node.config as { expression?: string })?.expression || '').trim()
  if (!expression) return 'amber'
  return 'green'
}

// ─── schema fallback ──────────────────────────────────────────────────────

/** fallbackSchemaFromWorkflow synthesises a minimal TableSchema by walking
 *  the body's field_refs. Used when the live schema fetch fails (e.g. the
 *  trigger table was deleted) so the body editor can still render the
 *  user's existing refs as known fields instead of all-red "missing".
 *
 *  The synthesised schema only has the field IDs the body mentions; field
 *  names default to `Field {id}` because we don't know the real name. The
 *  trade-off is intentional — we'd rather show a usable best-effort than
 *  block the editor with an "unknown table" error. */
export function fallbackSchemaFromWorkflow(workflow: WorkflowDefinition, body: BodyTemplate): TableSchema {
  const seen = new Set<string>()
  const fields: TableSchema['fields'] = []
  for (const part of body.parts || []) {
    if (part.kind !== 'field_ref' || !part.fieldRef?.fieldId || seen.has(part.fieldRef.fieldId)) {
      continue
    }
    seen.add(part.fieldRef.fieldId)
    fields.push({
      id: part.fieldRef.fieldId,
      name: `Field ${part.fieldRef.fieldId}`,
      type: 'text',
    })
  }
  return {
    id: workflow.trigger.tableId,
    name: workflow.trigger.tableId || 'Table',
    fields,
  }
}
