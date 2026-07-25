import { loadDesktopSettings } from '@/services/desktopSettings'
import { buildWritingRuntimeModel, resolveAgentTextModel } from '@/features/agent/lib/agentConfig'
import { WorkflowLauncher } from '@/features/workflow/components/launcher/WorkflowLauncher'
import type { LauncherView } from '@/features/workflow/components/launcher/WorkflowLauncherHero'
import type { TableSchema } from '@/features/workflow/components/BodyTemplateEditor.types'
import type { WorkflowRouteContext } from '@/features/workflow/lib/openWorkflowRoute'
import type { RuntimeWritingModel } from '@/types'

export interface WorkflowNewPageProps {
  tableName: string
  documentId?: string
  tableId?: string
  onSubmit: (input: {
    prompt: string
    model: RuntimeWritingModel
    /** The (documentId, tableId, tableName) tuple the AI build endpoint
     *  must anchor the workflow on. For the kitable-scoped mount this
     *  is the same as the (documentId, tableId, tableName) props; for
     *  the no-context mount it comes from WorkflowLauncher's inline
     *  table picker. */
    context: WorkflowRouteContext
  }) => void
  schemaLookup?: (documentId: string, tableId: string) => Promise<TableSchema>
  /** Initial launcher view. When the caller routes the user in for AI chat
   *  (mode=ai), pass 'ai-prompt' so the prompt textarea is the landing,
   *  not the gallery hero with a duplicate "Generate With AI" button. */
  initialView?: LauncherView
  /** Workspace root forwarded to the launcher's table picker (no-context
   *  mount only) so its lookup matches the trigger drawer's scope. */
  rootPath?: string
}

export function WorkflowNewPage({ tableName, documentId, tableId, onSubmit, schemaLookup, initialView, rootPath }: WorkflowNewPageProps) {
  const tableContext = {
    documentId: documentId || '',
    tableId: tableId || '',
    tableName,
  }

  async function handleAiSubmit(prompt: string, effectiveContext: WorkflowRouteContext) {
    const settings = await loadDesktopSettings()
    const modelName = resolveAgentTextModel(settings)
    const model = buildWritingRuntimeModel(settings, modelName)
    if (!model || !model.provider_type || !model.model_name) {
      window.dispatchEvent(new CustomEvent('kition:workflow:model-missing'))
      return
    }
    onSubmit({ prompt, model, context: effectiveContext })
  }

  return (
    <div data-testid="workflow-new-page" className="h-full overflow-y-auto bg-background">
      <WorkflowLauncher
        tableContext={tableContext}
        onAiSubmit={handleAiSubmit}
        schemaLookup={schemaLookup}
        initialView={initialView}
        rootPath={rootPath}
      />
    </div>
  )
}
