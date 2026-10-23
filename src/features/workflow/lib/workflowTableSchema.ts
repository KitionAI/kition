import { getTableFields } from '@/api/kitTables'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'

/**
 * Pull the schema of one table (the table file at `documentPath`, table
 * `tableId` in it) through the Table kit. Shared by the template creation
 * flow (createWorkflowFromMode), the home-page trigger editor (the lazy
 * schema cache), and any future entry point that needs to render field
 * references against a real table layout.
 *
 * Returns a TableSchema with field ids as strings of the kit's ids and
 * names from `title` when present (the human label), falling back to
 * `name` (the stable identifier), so the body editor's "Insert field"
 * picker matches what the user sees in the table.
 *
 * Rejects on failure so callers can `.catch(() => null)` and fall back to
 * an empty schema; the body editor downgrades to "missing field" warnings
 * in that case rather than dead-ending.
 */
export async function fetchWorkflowTableSchema(
  documentPath: string,
  tableId: string,
  tableName?: string,
): Promise<TableSchema> {
  const result = await getTableFields({ path: documentPath, tableId })
  const items = (result?.items ?? []) as Array<{ id?: number | string; name?: string; title?: string; type?: string }>
  const fields = items.map((field) => ({
    id: String(field.id ?? ''),
    name: String(field.title ?? '').trim() ? String(field.title) : String(field.name ?? ''),
    type: String(field.type ?? ''),
  }))
  const name = tableName || result?.table?.title || result?.table?.name || 'Table'
  return { id: tableId, name, fields }
}
