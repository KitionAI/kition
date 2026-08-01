import type { DataField, DataTable } from '@/types/dataDocument'

import type { FormSyncField, FormSyncFieldType } from './api'

export type FormSyncBuilderField = FormSyncField & {
  targetFieldTitle: string
}

export function buildInitialFormFields(table: DataTable): FormSyncBuilderField[] {
  const usedKeys = new Set<string>()
  return (table.fields || []).flatMap((field) => {
    const type = toFormFieldType(field)
    if (!type || field.readonly) return []
    const key = uniqueFieldKey(field.title || field.name || 'field', usedKeys)
    usedKeys.add(key)
    return [{
      key,
      label: field.title || field.name || 'Field',
      type,
      required: Boolean(field.required),
      ...(type === 'select' ? { options: field.options?.choices || [] } : {}),
      targetFieldTitle: field.title || field.name,
    }]
  })
}

export function createBuilderField(
  fields: FormSyncBuilderField[],
  targetFieldTitle: string,
): FormSyncBuilderField {
  const usedKeys = new Set(fields.map((field) => field.key))
  return {
    key: uniqueFieldKey('new_field', usedKeys),
    label: 'New field',
    type: 'text',
    required: false,
    targetFieldTitle,
  }
}

export function uniqueFieldKey(label: string, usedKeys: Set<string>) {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = /^[a-z]/.test(normalized) ? normalized : `field_${normalized || 'value'}`
  let candidate = base.slice(0, 48)
  let suffix = 2
  while (usedKeys.has(candidate)) {
    candidate = `${base.slice(0, 42)}_${suffix}`
    suffix += 1
  }
  return candidate
}

export function findTargetTable(
  tables: DataTable[] | undefined,
  tableId: string,
) {
  return (tables || []).find((table) => String(table.id) === String(tableId))
}

function toFormFieldType(field: DataField): FormSyncFieldType | null {
  if (field.type === 'long_text') return 'long_text'
  if (field.type === 'number') return 'number'
  if (field.type === 'date' || field.type === 'datetime') return 'datetime'
  if (field.type === 'single_select') return 'select'
  if (field.type !== 'text' && field.type !== 'url') return null
  const title = `${field.title} ${field.name}`.toLowerCase()
  if (title.includes('email')) return 'email'
  if (title.includes('phone') || title.includes('mobile')) return 'phone'
  return 'text'
}
