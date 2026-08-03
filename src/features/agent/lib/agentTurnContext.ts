import type { AgentBrowserContext, AgentPaneContext, AgentTaskMode } from '@/api/agent'
import type {
  BrowserPageContext,
  BrowserSessionProvider,
  WorkspaceDocumentFormat,
} from '@/services/desktop'
import type { DataDocument, DataTable } from '@/types/dataDocument'

export type AgentTurnContext = {
  activeDocumentPath: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDataDocumentId: number
  activeDataTableId: number
  browserContext?: AgentBrowserContext
  taskMode?: AgentTaskMode
  browserEnabled?: boolean
  /** Active workbench tab type — forwarded to streamAgentMessage so
   *  the backend can pick a pane-specific system-prompt addendum. */
  paneContext?: AgentPaneContext
  /** Workflow id when paneContext === 'workflow'. Drives the backend's
   *  active-workflow context block. */
  activeWorkflowId?: string
}

export function mapBrowserPageContextToAgentBrowserContext(
  pageContext: BrowserPageContext | null | undefined,
  provider?: BrowserSessionProvider,
  extraction?: {
    action?: string
    adapter?: string
    command?: string
    entityType?: string
    host?: string
  },
): AgentBrowserContext | undefined {
  if (!pageContext) {
    return undefined
  }
  return {
    source: 'desktop_embedded_browser',
    platform: provider || pageContext.provider,
    action: extraction?.action,
    adapter: extraction?.adapter,
    command: extraction?.command,
    entity_type: extraction?.entityType,
    host: pageContext.hostname || extraction?.host,
    page_url: pageContext.page_url,
    page_title: pageContext.page_title,
    logged_in: pageContext.logged_in,
    supported_page: pageContext.supported_page,
    editor_ready: pageContext.editor_ready,
    page_heading: pageContext.page_heading,
    title_text: pageContext.title_text,
    content_text_preview: pageContext.content_text_preview,
    visible_text_preview: pageContext.visible_text_preview,
    main_content_html: pageContext.main_content_html,
    html_snapshot: pageContext.html_snapshot,
    content_blocks: pageContext.content_blocks,
    page_type: pageContext.page_type,
    links: pageContext.links,
    extracted_entities: pageContext.extracted_entities,
    extracted_at: pageContext.extracted_at,
  }
}

export function buildActiveBrowserTabContext(input: {
  provider?: BrowserSessionProvider
  host?: string
  url?: string
  title?: string
}): AgentBrowserContext | undefined {
  const pageUrl = String(input.url || '').trim()
  const host = String(input.host || '').trim()
  if (!pageUrl && !host) {
    return undefined
  }
  return {
    source: 'desktop_embedded_browser',
    platform: input.provider,
    host: host || undefined,
    page_url: pageUrl || undefined,
    page_title: String(input.title || '').trim() || undefined,
  }
}

export function buildAgentTurnContext(input: {
  activeDocumentPath?: string
  activeDocumentFormat?: WorkspaceDocumentFormat
  activeDocument?: DataDocument | null
  activeTable?: DataTable | null
  activeDataDocumentId?: number | null
  activeDataTableId?: number | null
  browserContext?: AgentBrowserContext
  browserEnabled?: boolean
  paneContext?: AgentPaneContext
  activeWorkflowId?: string
}): AgentTurnContext {
  return {
    activeDocumentPath: String(input.activeDocumentPath || '').trim(),
    activeDocumentFormat: input.activeDocumentFormat,
    activeDataDocumentId: input.activeDocument?.id ?? input.activeDataDocumentId ?? 0,
    activeDataTableId: input.activeTable?.id ?? input.activeDataTableId ?? 0,
    browserContext: input.browserContext,
    paneContext: input.paneContext,
    activeWorkflowId: input.activeWorkflowId,
    taskMode: 'auto',
    browserEnabled: input.browserEnabled === true,
  }
}
