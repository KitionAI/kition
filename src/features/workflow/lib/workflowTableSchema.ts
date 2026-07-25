import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import { resolveApiURL } from '@/services/desktop'

/**
 * Pull schema for a single table off the data-document API. Shared by the
 * template creation flow (createWorkflowFromMode), the home-page trigger
 * editor (the lazy `schemaByTableId` cache), and any future entry point
 * that needs to render field references against a real table layout.
 *
 * Returns a TableSchema with normalised field IDs and names — uses
 * `title` when present (the human label) and falls back to `name` (the
 * stable identifier) so the body editor's "Insert field" picker matches
 * what the user sees in the table viewer.
 *
 * Throws on non-2xx so callers can `.catch(() => null)` and fall back to
 * an empty schema; the body editor downgrades to "missing field" warnings
 * in that case rather than dead-ending.
 */
export async function fetchWorkflowTableSchema(
  documentId: string,
  tableId: string,
  tableName: string,
): Promise<TableSchema> {
  const res = await fetch(resolveApiURL(`/v1/data-documents/${documentId}/tables/${tableId}/fields`))
  if (!res.ok) throw new Error(`schema fetch failed (${res.status})`)
  const envelope = (await res.json()) as {
    data?: { items?: Array<{ id: number | string; name: string; title?: string; type: string }> }
  }
  const items = envelope.data?.items ?? []
  const fields = items.map((f) => ({
    id: String(f.id),
    name: (f.title ?? '').trim() ? (f.title as string) : f.name,
    type: f.type,
  }))
  return { id: tableId, name: tableName, fields }
}
