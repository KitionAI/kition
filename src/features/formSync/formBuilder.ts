import { getTableFields } from '@/api/kitTables'

import type { FormSyncField, FormSyncFieldType } from './api'

/** A field of a form's destination table, as the Table kit answers it. */
export type FormTargetField = {
  id: string | number
  name: string
  title: string
  type: string
  readonly?: boolean
  required?: boolean
  options?: { choices?: string[] } | null
}

/** A form's destination table: a table of a table file, with its fields. */
export type FormTargetTable = { id: string; name: string; title: string; fields: FormTargetField[] }

/** The destination table `tableId` of the table file `path`, with its fields. */
export async function loadFormTargetTable(path: string, tableId: string): Promise<FormTargetTable> {
  const { items, table } = await getTableFields({ path, tableId })
  return { id: table.id, name: table.name, title: table.title, fields: items as FormTargetField[] }
}

export type FormSyncBuilderField = FormSyncField & {
  targetFieldTitle: string
}

export function buildInitialFormFields(table: FormTargetTable): FormSyncBuilderField[] {
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

export function findTargetTable<T extends { id: string | number }>(
  tables: T[] | undefined,
  tableId: string,
) {
  return (tables || []).find((table) => String(table.id) === String(tableId))
}

function toFormFieldType(field: FormTargetField): FormSyncFieldType | null {
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
