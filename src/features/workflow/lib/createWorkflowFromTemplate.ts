import type { CreateWorkflowInput, WorkflowPatch } from '@/features/workflow/api'
import type { BodyPart, BodyTemplate, TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { detectBrowserTimezone } from '@/features/workflow/components/ScheduledTriggerPropertiesPanel'
import type {
  WorkflowTemplate,
  TemplateBodyPart,
} from '@/features/workflow/templates'

export interface TemplateApplyContext {
  /** Document of the table the user picked in the launcher. Always set;
   *  scheduled_time templates ignore it (no table binding). */
  documentId: string
  /** Table the user picked in the launcher. scheduled_time templates ignore
   *  this — they bind by clock, not by record event. */
  tableId: string
  tableName: string
  /** Schema of the bound table. Drives field_ref resolution in send_email
   *  bodies. Null when the schema fetch hasn't completed (template still
   *  applies, but field refs downgrade to fallback text). */
  schema: TableSchema | null
  /** Other tables in the same kitable. Context-aware add_record templates
   *  resolve their target table and target field IDs from this list. */
  tables?: Array<{
    documentId: string
    tableId: string
    tableName: string
    schema: TableSchema | null
  }>
  currentUserEmail?: string
}

const PLACEHOLDER_EMAIL = 'you@example.com'

export interface CreateWorkflowFromTemplateResult {
  input: CreateWorkflowInput
  /** Filter templates need a second PATCH because the create endpoint keeps
   *  the legacy trigger/action payload. The patch persists the graph and
   *  flips enabled only after the filter is safely stored. */
  graphPatch?: WorkflowPatch
  /** Field names that the template asked for but couldn't be matched on the
   *  bound table's schema. The body still applies (those parts downgrade to
   *  the template's fallback text), but the caller can surface a banner so
   *  the user knows to fix the bindings. Empty list = perfect match. */
  unresolvedFieldNames: string[]
}

export function createWorkflowFromTemplate(
  tpl: WorkflowTemplate,
  ctx: TemplateApplyContext,
): CreateWorkflowFromTemplateResult {
  const unresolved: string[] = []
  const action = resolveAction(tpl, ctx, unresolved)
  const trigger = resolveTrigger(tpl, ctx, unresolved)
  const filter = resolveFilter(tpl, ctx.schema, unresolved)
  const shouldEnable = Boolean(tpl.enabledByDefault && unresolved.length === 0 && isActionReady(action))
  const input: CreateWorkflowInput = {
    name: tpl.draft.name,
    description: tpl.draft.description,
    enabled: shouldEnable && !filter,
    trigger,
    action,
  }
  return {
    input,
    graphPatch: filter ? buildFilterGraphPatch(input, filter, shouldEnable) : undefined,
    unresolvedFieldNames: unresolved,
  }
}

function resolveFilter(
  tpl: WorkflowTemplate,
  schema: TableSchema | null,
  unresolvedFieldNames: string[],
) {
  const filter = tpl.draft.filter
  if (!filter?.conditions.length) return null
  const expressions = filter.conditions.flatMap((condition) => {
    const field = schema?.fields.find(
      (item) => normalizeName(item.name) === normalizeName(condition.fieldName),
    )
    if (!field || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) {
      addUnresolved(unresolvedFieldNames, condition.fieldName)
      return []
    }
    return [`trigger_1.${field.name} ${condition.op} ${filterLiteral(condition.value)}`]
  })
  if (expressions.length !== filter.conditions.length) return null
  return {
    expression: expressions.join(filter.mode === 'all' ? ' and ' : ' or '),
    mode: filter.mode,
  }
}

function filterLiteral(value: string | number | boolean) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function buildFilterGraphPatch(
  input: CreateWorkflowInput,
  filter: { expression: string; mode: 'all' | 'any' },
  enabled: boolean,
): WorkflowPatch {
  const triggerNodeId = 'trigger_1'
  const filterNodeId = 'filter_1'
  const actionNodeId = 'action_1'
  return {
    enabled,
    nodes: [
      { nodeId: triggerNodeId, kind: 'trigger', config: { nodeId: triggerNodeId, ...input.trigger } },
      {
        nodeId: filterNodeId,
        kind: 'filter',
        config: { nodeId: filterNodeId, type: 'filter', expression: filter.expression, mode: filter.mode },
      },
      { nodeId: actionNodeId, kind: 'action', config: { nodeId: actionNodeId, ...input.action } },
    ],
    edges: [
      { from: triggerNodeId, to: filterNodeId },
      { from: filterNodeId, to: actionNodeId },
    ],
  }
}

/** resolveTrigger materialises the template's trigger blueprint against the
 *  apply context. scheduled_time skips the table binding entirely (the
 *  scheduler doesn't watch a table) and instead ships the cron expression.
 *  All other trigger types bind to the user-picked table. */
function resolveTrigger(
  tpl: WorkflowTemplate,
  ctx: TemplateApplyContext,
  unresolvedFieldNames: string[],
): CreateWorkflowInput['trigger'] {
  if (tpl.draft.trigger.type === 'scheduled_time') {
    return {
      type: 'scheduled_time',
      // scheduled_time intentionally leaves table fields empty — the backend
      // validator (and the canvas) special-cases this trigger type to skip
      // the "pick a table" gate. We still pass the picked tableId on the
      // payload as documentation: it tells the launcher "this came from
      // the X table's context" without enabling the table binding.
      documentId: '',
      tableId: '',
      // Default the timezone to the browser's IANA name so newly-created
      // scheduled workflows fire when the user actually expects them to.
      // The template itself may override the timezone (e.g. an "Auckland
      // standup reminder" preset) — when not specified we pick up the
      // user's clock. Empty would silently fall back to server local at
      // run time, which only matches the user's expectation when those
      // two timezones happen to agree.
      schedule: {
        cron: tpl.draft.trigger.schedule.cron,
        timezone: tpl.draft.trigger.schedule.timezone || detectBrowserTimezone(),
      },
    }
  }
  return {
    type: tpl.draft.trigger.type,
    documentId: ctx.documentId,
    tableId: ctx.tableId,
    requiredFields: resolveRequiredFields(
      tpl.draft.trigger.requiredFieldNames || [],
      ctx.schema,
      unresolvedFieldNames,
    ),
  }
}

/** resolveAction materialises the template's action blueprint. send_email
 *  templates run through token substitution + body-part resolution;
 *  add_record templates either resolve a sibling target table and its field
 *  assignments or remain empty for the generic delayed-binding path.
 *
 *  Side effect: unresolvedFieldNames is appended with every field_ref_by_name
 *  the schema couldn't match. The caller (createWorkflowFromTemplate) uses
 *  that list to surface a post-creation banner — silently downgrading to
 *  fallback text was the original misery the U4 review flagged.
 */
function resolveAction(
  tpl: WorkflowTemplate,
  ctx: TemplateApplyContext,
  unresolvedFieldNames: string[],
): CreateWorkflowInput['action'] {
  if (tpl.draft.action.type === 'update_record') {
    const fields = tpl.draft.action.fields.flatMap((assignment) => {
      const targetField = findField(ctx.schema, assignment.targetFieldName)
      if (!targetField) {
        addUnresolved(unresolvedFieldNames, assignment.targetFieldName)
        return []
      }
      return [{ fieldId: targetField.id, value: { parts: resolveBodyParts(assignment.valueParts, ctx.schema, unresolvedFieldNames) } }]
    })
    return emptyAction('update_record', { updateRecord: { target: 'trigger_record', fields } })
  }
  if (tpl.draft.action.type === 'lookup_record') {
    const lookup = tpl.draft.action
    const target = ctx.tables?.find((table) => normalizeName(table.tableName) === normalizeName(lookup.targetTableName))
    if (!target) addUnresolved(unresolvedFieldNames, lookup.targetTableName)
    const matchField = findField(target?.schema || null, lookup.matchFieldName)
    if (!matchField) addUnresolved(unresolvedFieldNames, lookup.matchFieldName)
    const writeBack = lookup.writeBack.flatMap((mapping) => {
      const sourceField = findField(target?.schema || null, mapping.sourceFieldName)
      const targetField = findField(ctx.schema, mapping.targetFieldName)
      if (!sourceField) addUnresolved(unresolvedFieldNames, mapping.sourceFieldName)
      if (!targetField) addUnresolved(unresolvedFieldNames, mapping.targetFieldName)
      return sourceField && targetField ? [{ sourceFieldId: sourceField.id, targetFieldId: targetField.id }] : []
    })
    return emptyAction('lookup_record', {
      lookupRecord: {
        targetDocumentId: target?.documentId,
        targetTableId: target?.tableId || '',
        matchFieldId: matchField?.id || '',
        matchValue: { parts: resolveBodyParts(lookup.matchValueParts, ctx.schema, unresolvedFieldNames) },
        writeBack,
      },
    })
  }
  if (tpl.draft.action.type === 'transform_record') {
    const operations = tpl.draft.action.operations.flatMap((operation) => {
      const targetField = findField(ctx.schema, operation.targetFieldName)
      if (!targetField) {
        addUnresolved(unresolvedFieldNames, operation.targetFieldName)
        return []
      }
      return [{
        source: { parts: resolveBodyParts(operation.sourceParts, ctx.schema, unresolvedFieldNames) },
        operation: operation.operation,
        argument: operation.argument,
        targetFieldId: targetField.id,
      }]
    })
    return emptyAction('transform_record', { transformRecord: { operations } })
  }
  if (tpl.draft.action.type === 'add_record') {
    const targetTableName = tpl.draft.action.targetTableName?.trim() || ''
    const target = targetTableName
      ? ctx.tables?.find((table) => normalizeName(table.tableName) === normalizeName(targetTableName))
      : undefined
    if (targetTableName && !target) addUnresolved(unresolvedFieldNames, targetTableName)
    const assignments = (tpl.draft.action.fields || []).flatMap((assignment) => {
      const targetField = target?.schema?.fields.find(
        (field) => normalizeName(field.name) === normalizeName(assignment.targetFieldName),
      )
      if (!targetField) {
        if (assignment.targetFieldName) addUnresolved(unresolvedFieldNames, assignment.targetFieldName)
        return []
      }
      return [{
        fieldId: targetField.id,
        value: {
          parts: resolveBodyParts(assignment.valueParts, ctx.schema, unresolvedFieldNames),
        },
      }]
    })
    return {
      type: 'add_record',
      connectionId: '',
      // send_email scaffolding stays empty because the backend's
      // CreateWorkflowInput shape keeps to/subject/body on the union for
      // historical reasons (single ActionConfig struct, not a union). The
      // server's Validate() skips these checks when action.type !== send_email.
      to: '',
      subject: { parts: [] },
      body: { parts: [] },
      addRecord: {
        targetDocumentId: target?.documentId,
        targetTableId: target?.tableId || '',
        fields: assignments,
      },
    }
  }
  const body: BodyTemplate = { parts: resolveBodyParts(tpl.draft.action.bodyParts, ctx.schema, unresolvedFieldNames) }
  return {
    type: 'send_email',
    connectionId: '',
    to: substituteTokens(tpl.draft.action.to, ctx),
    subject: tpl.draft.action.subject
      ? { parts: [{ kind: 'text', text: tpl.draft.action.subject }] }
      : { parts: [] },
    body,
  }
}

function substituteTokens(input: string, ctx: TemplateApplyContext): string {
  if (input === '{{me}}') {
    return ctx.currentUserEmail || PLACEHOLDER_EMAIL
  }
  if (input === '{{email_field}}') {
    // Reserved for future runtime resolution; today we drop in a placeholder
    // so the value is a valid email and the user can edit it.
    return PLACEHOLDER_EMAIL
  }
  return input
}

function resolveBodyParts(
  parts: TemplateBodyPart[],
  schema: TableSchema | null,
  unresolvedFieldNames: string[],
): BodyPart[] {
  return parts.flatMap<BodyPart>((part) => {
    if (part.kind === 'text') return [{ kind: 'text', text: part.text }]
    if (part.kind === 'newline') return [{ kind: 'newline' }]
    const field = schema?.fields.find((f) => f.name.toLowerCase() === part.fieldName.toLowerCase())
    if (!field) {
      // Schema didn't have a column matching the template's expected name —
      // either the schema fetch hasn't completed yet or the template was
      // built against a different table layout. Record the miss so the
      // caller can surface a banner, then fall back to the fallback text so
      // the workflow still renders something useful.
      addUnresolved(unresolvedFieldNames, part.fieldName)
      return [{ kind: 'text', text: part.fallback }]
    }
    return [{ kind: 'field_ref', fieldRef: { nodeId: 'trigger_1', fieldId: field.id } }]
  })
}

function resolveRequiredFields(
  fieldNames: string[],
  schema: TableSchema | null,
  unresolvedFieldNames: string[],
): string[] {
  return fieldNames.flatMap((fieldName) => {
    const field = schema?.fields.find((candidate) => normalizeName(candidate.name) === normalizeName(fieldName))
    if (field) return [field.id]
    addUnresolved(unresolvedFieldNames, fieldName)
    return []
  })
}

function isActionReady(action: CreateWorkflowInput['action']) {
  if (action.type === 'add_record') {
    return Boolean(action.addRecord?.targetTableId && action.addRecord.fields.length > 0)
  }
  if (action.type === 'update_record') return Boolean(action.updateRecord?.fields.length)
  if (action.type === 'lookup_record') return Boolean(action.lookupRecord?.targetTableId && action.lookupRecord.matchFieldId && action.lookupRecord.writeBack.length)
  if (action.type === 'transform_record') return Boolean(action.transformRecord?.operations.length)
  return false
}

function emptyAction<T extends CreateWorkflowInput['action']['type']>(type: T, config: Partial<CreateWorkflowInput['action']>): CreateWorkflowInput['action'] {
  return { type, connectionId: '', to: '', subject: { parts: [] }, body: { parts: [] }, ...config }
}

function findField(schema: TableSchema | null, name: string) {
  return schema?.fields.find((field) => normalizeName(field.name) === normalizeName(name))
}

function addUnresolved(items: string[], value: string) {
  if (value && !items.includes(value)) items.push(value)
}

function normalizeName(value?: string) {
  return String(value || '').trim().toLocaleLowerCase()
}
