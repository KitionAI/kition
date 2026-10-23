import { getTableFields, listTableFiles, listTableRecords } from '@/api/kitTables'
import type { IndexableDoc, MetaAnchor, RecordAnchor } from '../types'

type FieldType =
  | 'text' | 'long_text' | 'number' | 'date' | 'datetime'
  | 'single_select' | 'multi_select' | 'checkbox'
  | 'attachment' | 'document_link' | 'formula' | 'ai'
  | 'rating' | 'user' | 'link_to_record' | 'lookup' | 'rollup'
  | 'button' | 'created_time' | 'last_modified_time'

/** `name` is what people call the field; `key` keys its values in a record. */
type TableSearchField = { id: string; name: string; key: string; type: FieldType }
type TableSearchView  = { id: string; name: string }
type TableSearchRecord = { id: string; values: Record<string, unknown> }

export type TableSearchInput = {
  vaultPath: string
  tableId: string
  tableName: string
  fields: TableSearchField[]
  views:  TableSearchView[]
  records: TableSearchRecord[]
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

export function extractTableDocs(input: TableSearchInput): IndexableDoc[] {
  const { vaultPath, tableId, tableName, fields, views, records } = input
  const tableTag = `table:${tableName}`
  const docs: IndexableDoc[] = []

  // record docs
  for (const rec of records) {
    const bodyLines: string[] = []
    const selectLabels: string[] = []
    for (const f of fields) {
      const { display, selectLabels: sels } = stringifyCell(rec.values[f.key], f.type)
      if (display.length) bodyLines.push(`${f.name}: ${display}`)
      selectLabels.push(...sels)
    }
    const tags = [tableTag, ...selectLabels]
    const anchor: RecordAnchor = { kind: 'record', tableId, recordId: rec.id }
    docs.push({
      id: `table:${vaultPath}:${tableId}:rec:${rec.id}`,
      kind: 'table_record',
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
      id: `table:${vaultPath}:${tableId}:meta:table`,
      kind: 'table_meta',
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
      id: `table:${vaultPath}:${tableId}:meta:field:${f.id}`,
      kind: 'table_meta',
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
      id: `table:${vaultPath}:${tableId}:meta:view:${v.id}`,
      kind: 'table_meta',
      vaultPath,
      title: v.name,
      body: v.name,
      tags: [tableTag],
      anchor,
    })
  }

  return docs
}

/** Every table of the table file `vaultPath`, with its fields and records, read through the Table kit. */
export async function loadTableSearchFile(vaultPath: string): Promise<TableSearchInput[]> {
  const { files } = await listTableFiles()
  const file = files.find((candidate) => candidate.path === vaultPath)
  if (!file) return []
  return Promise.all(file.tables.map(async (table) => {
    const [{ items }, page] = await Promise.all([
      getTableFields({ path: vaultPath, tableId: table.id }),
      listTableRecords({ path: vaultPath, tableId: table.id }),
    ])
    const fields = (items as Array<{ id: unknown; name?: unknown; title?: unknown; type?: unknown }>).map((field) => ({
      id: String(field.id),
      name: String(field.title || field.name || ''),
      key: String(field.name ?? ''),
      type: String(field.type ?? 'text') as FieldType,
    }))
    return {
      vaultPath,
      tableId: table.id,
      tableName: table.title || table.name,
      fields,
      views: [],
      records: (page.items || []).map((record) => ({ id: String(record.id), values: (record.values || {}) as Record<string, unknown> })),
    }
  }))
}

/** Every table file of the workspace, for the search index's first load. */
export async function loadAllTableSearchDocs(): Promise<IndexableDoc[]> {
  const { files } = await listTableFiles()
  const docs: IndexableDoc[] = []
  for (const file of files) {
    for (const table of await loadTableSearchFile(file.path)) docs.push(...extractTableDocs(table))
  }
  return docs
}
