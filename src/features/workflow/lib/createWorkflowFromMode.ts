import { createWorkflow, patchWorkflow, type WorkflowDefinition } from '@/features/workflow/api'
import { listDataDocuments } from '@/api/dataDocuments'
import { createWorkflowFromTemplate } from '@/features/workflow/lib/createWorkflowFromTemplate'
import type { WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
// The schema fetcher used to live here; it moved to its own file (WF-C1e)
// so the home page can share the same fetcher without dragging in this
// module's createWorkflow flow. Re-exported below for callers who already
// import it from createWorkflowFromMode.
export { fetchWorkflowTableSchema } from '@/features/workflow/lib/workflowTableSchema'
import { fetchWorkflowTableSchema } from '@/features/workflow/lib/workflowTableSchema'
import type { WorkflowTemplate } from '@/features/workflow/templates'

/**
 * Run the "From a template" branch of the create-workflow mode dialog.
 *
 * Fetches the schema for the chosen table (so the template's body
 * placeholders resolve), composes a `CreateWorkflowInput` via
 * `createWorkflowFromTemplate`, and POSTs it to `/v1/workflows`. Returns
 * the created definition + a `unresolvedFieldNames` hint so the caller can
 * surface a "X fields couldn't be matched" banner on the editor page.
 *
 * `context` may be null when the caller is creating an workflow without a
 * pre-bound table (the "delayed table binding" flow). In that case the
 * template body's field refs fall back to literal placeholders and the
 * resulting workflow persists as a draft (Enabled=false, tableId="") —
 * the user binds the table from the trigger config panel afterward.
 *
 * Errors from schema fetch are swallowed — the template helper handles the
 * missing-schema case (body parts fall back to literal placeholders).
 */
export interface CreateWorkflowFromModeResult {
  workflow: WorkflowDefinition
  unresolvedFieldNames: string[]
}

export async function createWorkflowFromMode(
  template: WorkflowTemplate,
  context: WorkflowRouteContext | null,
): Promise<CreateWorkflowFromModeResult> {
  const schema = context
    ? await fetchWorkflowTableSchema(
        context.documentId,
        context.tableId,
        context.tableName,
      ).catch(() => null)
    : null
  const tables = context
    ? await loadSiblingTableContexts(template, context).catch(() => [])
    : []
  const { input, graphPatch, unresolvedFieldNames } = createWorkflowFromTemplate(template, {
    documentId: context?.documentId ?? '',
    tableId: context?.tableId ?? '',
    tableName: context?.tableName ?? '',
    schema,
    tables,
  })
  let workflow = await createWorkflow(input)
  if (graphPatch) {
    workflow = await patchWorkflow(workflow.id, graphPatch)
  }
  return { workflow, unresolvedFieldNames }
}

async function loadSiblingTableContexts(
  template: WorkflowTemplate,
  context: WorkflowRouteContext,
) {
  if (template.draft.action.type !== 'add_record' || !template.draft.action.targetTableName) {
    return []
  }
  const docs = await listDataDocuments()
  const document = (docs.items || []).find((item) => String(item.id) === String(context.documentId))
  if (!document) return []
  const wanted = template.draft.action.targetTableName.trim().toLocaleLowerCase()
  const table = (document.tables || []).find((item) => {
    return [item.title, item.name].some((value) => String(value || '').trim().toLocaleLowerCase() === wanted)
  })
  if (!table) return []
  const tableId = String(table.id)
  const tableName = String(table.title || table.name || template.draft.action.targetTableName)
  const targetSchema = await fetchWorkflowTableSchema(context.documentId, tableId, tableName).catch(() => null)
  return [{
    documentId: context.documentId,
    tableId,
    tableName,
    schema: targetSchema,
  }]
}
