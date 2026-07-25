import type { IndexableDoc, MetaAnchor, RecordAnchor } from '../types'

export const KITABLE_SOURCE_VERSION = '1'

export type FieldType =
  | 'text' | 'long_text' | 'number' | 'date' | 'datetime'
  | 'single_select' | 'multi_select' | 'checkbox'
  | 'attachment' | 'document_link' | 'formula' | 'ai'
  | 'rating' | 'user' | 'link_to_record' | 'lookup' | 'rollup'
  | 'button' | 'created_time' | 'last_modified_time'

export type KitableField = { id: string; name: string; type: FieldType }
export type KitableView  = { id: string; name: string }
export type KitableRecord = { id: string; values: Record<string, unknown> }

export type KitableTableInput = {
  vaultPath: string
  tableId: string
  tableName: string
  fields: KitableField[]
  views:  KitableView[]
  records: KitableRecord[]
}

function stringifyCell(value: unknown, type: FieldType): { display: string; selectLabels: string[] } {
  if (value == null) return { display: '', selectLabels: [] }
  if (type === 'attachment' && Array.isArray(value)) {
    const names = value
      .map(v => (v as { name?: string } | null)?.name)
      .filter((n): n is string => !!n)
    return { display: names.join(', '), selectLabels: [] }
  }
  if (type === 'single_select' && typeof value === 'string') {
    return { display: value, selectLabels: [value] }
  }
  if (type === 'multi_select' && Array.isArray(value)) {
    const labels = value.filter((v): v is string => typeof v === 'string')
    return { display: labels.join(', '), selectLabels: labels }
  }
  if (type === 'link_to_record' && Array.isArray(value)) {
    const names = value
      .map(v => (v as { display?: string } | null)?.display)
      .filter((n): n is string => !!n)
    return { display: names.join(', '), selectLabels: [] }
  }
  if (type === 'user' && Array.isArray(value)) {
    const names = value
      .map(v => (v as { name?: string } | null)?.name)
      .filter((n): n is string => !!n)
    return { display: names.join(', '), selectLabels: [] }
  }
  if (type === 'ai') {
    if (typeof value === 'string') return { display: value, selectLabels: [] }
    if (value && typeof value === 'object' && 'value' in (value as object)) {
      const v = (value as { value: unknown }).value
      return { display: typeof v === 'string' ? v : String(v ?? ''), selectLabels: [] }
    }
  }
  return { display: String(value), selectLabels: [] }
}

export function extractKitableDocs(input: KitableTableInput): IndexableDoc[] {
  const { vaultPath, tableId, tableName, fields, views, records } = input
  const tableTag = `kitable:${tableName}`
  const docs: IndexableDoc[] = []

  // record docs
  for (const rec of records) {
    const bodyLines: string[] = []
    const selectLabels: string[] = []
    for (const f of fields) {
      const { display, selectLabels: sels } = stringifyCell(rec.values[f.id], f.type)
      if (display.length) bodyLines.push(`${f.name}: ${display}`)
      selectLabels.push(...sels)
    }
    const tags = [tableTag, ...selectLabels]
    const anchor: RecordAnchor = { kind: 'record', tableId, recordId: rec.id }
    docs.push({
      id: `kitable:${vaultPath}:${tableId}:rec:${rec.id}`,
      kind: 'kitable_record',
      vaultPath,
      title: tableName,
      body: bodyLines.join('\n'),
      tags,
      anchor,
    })
  }

  // meta: table
  {
    const anchor: MetaAnchor = { kind: 'meta', tableId, metaKind: 'table', metaId: tableId }
    docs.push({
      id: `kitable:${vaultPath}:${tableId}:meta:table`,
      kind: 'kitable_meta',
      vaultPath,
      title: tableName,
      body: tableName,
      tags: [tableTag],
      anchor,
    })
  }

  // meta: fields
  for (const f of fields) {
    const anchor: MetaAnchor = { kind: 'meta', tableId, metaKind: 'field', metaId: f.id }
    docs.push({
      id: `kitable:${vaultPath}:${tableId}:meta:field:${f.id}`,
      kind: 'kitable_meta',
      vaultPath,
      title: f.name,
      body: f.name,
      tags: [tableTag],
      anchor,
    })
  }

  // meta: views
  for (const v of views) {
    const anchor: MetaAnchor = { kind: 'meta', tableId, metaKind: 'view', metaId: v.id }
    docs.push({
      id: `kitable:${vaultPath}:${tableId}:meta:view:${v.id}`,
      kind: 'kitable_meta',
      vaultPath,
      title: v.name,
      body: v.name,
      tags: [tableTag],
      anchor,
    })
  }

  return docs
}
