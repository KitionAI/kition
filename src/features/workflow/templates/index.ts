import { buildBuiltinTemplates, type TemplateTranslator } from './builtins'

export type TemplateIconRef =
  | { kind: 'lucide'; name: 'AlarmClock' | 'MessageSquare' | 'Sparkles' | 'Send' | 'FileText' | 'CalendarClock' | 'Plus' | 'Database' }
  | { kind: 'emoji'; char: string }

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  icons: TemplateIconRef[]
  badgeCount?: number
  /** Restrict a template to source tables whose visible name matches one of
   *  these values. Context-specific templates stay out of unrelated tables
   *  instead of creating a half-bound workflow. */
  sourceTableNames?: string[]
  /** Local-only templates can opt into immediate activation when every
   *  trigger/action binding resolves cleanly. */
  enabledByDefault?: boolean
  draft: TemplateDraft
}

/** TemplateDraft is the in-memory shape a template ships with — a partial
 *  workflow blueprint that `createWorkflowFromTemplate` materialises into a
 *  CreateWorkflowInput payload. The trigger and action are discriminated
 *  unions because their required fields differ sharply:
 *    - record_created / record_updated / record_created_or_updated /
 *      record_date_reached: all bind to the table the user
 *      just picked in the launcher; the template carries no extra config.
 *    - scheduled_time: carries a cron expression and binds to NO table —
 *      the scheduler fires by clock, not by record event. Mirrors the
 *      Feishu Base "At scheduled time" entry. */
export type TemplateTrigger =
  | {
      type: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'record_date_reached'
      requiredFieldNames?: string[]
    }
  | { type: 'scheduled_time'; schedule: { cron: string; timezone?: string } }

/** TemplateAction discriminates by `type` so each action's required fields
 *  stay self-contained:
 *    - send_email: to/subject/body, the original template path.
 *    - add_record: may stay empty for a generic delayed-binding template, or
 *      identify a sibling target table + field assignments by visible name.
 *      The apply step resolves those names to stable IDs before creation. */
export type TemplateAction =
  | { type: 'send_email'; to: string; subject: string; bodyParts: TemplateBodyPart[] }
  | {
      type: 'add_record'
      targetTableName?: string
      fields?: Array<{ targetFieldName: string; valueParts: TemplateBodyPart[] }>
    }
  | {
      type: 'update_record'
      fields: Array<{ targetFieldName: string; valueParts: TemplateBodyPart[] }>
    }
  | {
      type: 'lookup_record'
      targetTableName: string
      matchFieldName: string
      matchValueParts: TemplateBodyPart[]
      writeBack: Array<{ sourceFieldName: string; targetFieldName: string }>
    }
  | {
      type: 'transform_record'
      operations: Array<{
        sourceParts: TemplateBodyPart[]
        operation: 'trim' | 'lowercase' | 'uppercase' | 'digits_only' | 'domain_from_email' | 'concat' | 'number_add' | 'number_multiply'
        argument?: string
        targetFieldName: string
      }>
    }

export interface TemplateDraft {
  name: string
  description: string
  trigger: TemplateTrigger
  filter?: {
    mode: 'all' | 'any'
    conditions: Array<{
      fieldName: string
      op: '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith' | 'endsWith' | 'in'
      value: string | number | boolean
    }>
  }
  action: TemplateAction
}

export type TemplateBodyPart =
  | { kind: 'text'; text: string }
  | { kind: 'newline' }
  | { kind: 'field_ref_by_name'; fieldName: string; fallback: string }

export function getBuiltinTemplates(
  t: TemplateTranslator,
  context?: { tableName?: string },
): WorkflowTemplate[] {
  const tableName = normalizeName(context?.tableName)
  return buildBuiltinTemplates(t).filter((template) => {
    if (!template.sourceTableNames?.length) return true
    if (!tableName) return false
    return template.sourceTableNames.some((name) => normalizeName(name) === tableName)
  })
}

function normalizeName(value?: string) {
  return String(value || '').trim().toLocaleLowerCase()
}
