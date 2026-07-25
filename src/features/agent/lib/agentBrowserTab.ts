import type { AgentTaskMode } from '@/api/agent'
import {
  OPEN_WORKSPACE_BROWSER_TAB_EVENT,
  dispatchOpenWorkspaceBrowserTab,
  type WorkspaceBrowserTabPayload,
} from '@/features/workspace/lib/browserTabs'
import type { BrowserSessionProvider } from '@/services/desktop'
import type { DataDocument, DataTable } from '@/types/dataDocument'

export { OPEN_WORKSPACE_BROWSER_TAB_EVENT, dispatchOpenWorkspaceBrowserTab }
export type { WorkspaceBrowserTabPayload }

export function buildAgentBrowserTabOrigin(
  activeDocument: DataDocument | null,
  documentPath?: string,
  activeTable?: DataTable | null,
) {
  const resolvedPath = String(documentPath || activeDocument?.path || '').trim()
  const originTabId = resolvedPath ? `document:${resolvedPath}` : ''
  const originLabel = String(
    activeTable?.title || activeDocument?.title || '',
  ).trim()
  return {
    originTabId,
    originDocumentPath: resolvedPath,
    originTableId: activeTable?.id,
    originLabel,
  }
}

export function buildAgentBrowserTabPayload(input: {
  provider: BrowserSessionProvider
  taskMode?: AgentTaskMode
  host?: string
  url?: string
  title?: string
  query?: string
  activeDocument?: DataDocument | null
  documentPath?: string
  activeTable?: DataTable | null
  activate?: boolean
  insertAfterActive?: boolean
}): WorkspaceBrowserTabPayload {
  const originRef = buildAgentBrowserTabOrigin(
    input.activeDocument ?? null,
    input.documentPath,
    input.activeTable ?? null,
  )
  return {
    provider: input.provider,
    task_mode: input.taskMode,
    host: input.host,
    url: input.url,
    title: input.title || '',
    query: String(input.query || '').trim(),
    activate: input.activate ?? true,
    insertAfterActive: input.insertAfterActive ?? true,
    origin_tab_id: originRef.originTabId,
    origin_document_path: originRef.originDocumentPath,
    origin_table_id: originRef.originTableId,
    origin_label: originRef.originLabel,
  }
}
