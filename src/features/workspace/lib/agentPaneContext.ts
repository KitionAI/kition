import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocumentFormat } from '@/services/desktop'
import type { AgentPaneContext } from '@/features/agent/lib/paneEmptyState'

// deriveAgentPaneContext maps a workbench tab to the agent panel's pane
// context. Two call sites in WorkspaceScreen consume the same mapping:
// the empty-state copy lookup and the buildAgentTurnContext payload. If
// those drift apart the agent backend's system-prompt addendum stops
// matching what the user sees on the empty-state card — that's exactly
// the desync docs/workflow-ai-chat-ux-review.md P1-2 warns about. This
// helper is the single source of truth, with a spec that exhaustively
// covers every WorkspaceTab variant.
//
// Mapping rationale:
//   document        → 'document'  (the prose editor pane)
//   file-viewer     → 'document' for prose/code formats (pdf, markdown,
//                                  docx, csv, json, text, html, …);
//                    → 'gallery'  for media formats (image, video, audio) —
//                                  "Summarize this document" reads as a bug
//                                  when the user is staring at a PNG
//   browser         → 'browser'       (embedded browser session — a page is loaded)
//   browser-sites   → 'browserSites'  (sites list — no page loaded; needs its own
//                                      suggestion set so 'Summarize this page' doesn't
//                                      show next to a discovery UI)
//   workflow        → 'workflow'  (workflow editor)
//   table           → 'table'     (data-table editor)
//   dashboard       → 'table'     (data reporting over a table)
//   gallery         → 'gallery'   (image gallery)
//   null/undefined  → 'document'  (no tab open — fall back to general assistance)
export function deriveAgentPaneContext(
  tab: WorkspaceTab | null | undefined,
): AgentPaneContext {
  if (!tab) {
    return 'document'
  }
  switch (tab.type) {
    case 'document':
      return 'document'
    case 'file-viewer':
      // Media files in a single-file preview behave more like the
      // gallery pane than a document — the user wants "describe this
      // asset" / "pick the best frame" rather than "summarize this
      // document". Gallery suggestions already use neutral 'item' wording
      // (iter 10) so this reuse stays accurate.
      switch (tab.format) {
        case 'image':
        case 'video':
        case 'audio':
          return 'gallery'
        default:
          return 'document'
      }
    case 'browser':
      return 'browser'
    case 'browser-sites':
      return 'browserSites'
    case 'workflow':
      return 'workflow'
    case 'table':
    case 'dashboard':
      return 'table'
    case 'gallery':
      return 'gallery'
    default: {
      // Exhaustiveness check — adding a new WorkspaceTab variant without
      // teaching this switch about it surfaces here as a tsc error,
      // forcing the author to decide the mapping intentionally instead
      // of silently falling back to 'document'.
      const _exhaustive: never = tab
      void _exhaustive
      return 'document'
    }
  }
}

export function resolveAgentActiveDocument(
  tab: WorkspaceTab | null | undefined,
): { path: string; format?: WorkspaceDocumentFormat } {
  if (!tab) {
    return { path: '' }
  }
  switch (tab.type) {
    case 'document':
    case 'file-viewer':
      return { path: tab.path, format: tab.format }
    case 'table':
    case 'dashboard':
      return { path: tab.kitablePath, format: 'data' }
    case 'workflow':
      return {
        path: tab.kitablePath || '',
        format: tab.kitablePath ? 'data' : undefined,
      }
    case 'browser':
      return {
        path: tab.originDocumentPath || '',
        format: tab.originDocumentPath?.toLowerCase().endsWith('.kitable')
          ? 'data'
          : undefined,
      }
    case 'browser-sites':
    case 'gallery':
      return { path: '' }
    default: {
      const _exhaustive: never = tab
      void _exhaustive
      return { path: '' }
    }
  }
}

export function resolveAgentDataTableTarget(
  tab: WorkspaceTab | null | undefined,
): { documentPath: string; tableId: number | null } | null {
  if (!tab) {
    return null
  }
  if (tab.type === 'table') {
    return {
      documentPath: String(tab.kitablePath || '').trim(),
      tableId: tab.tableId,
    }
  }
  if (
    tab.type === 'document'
    && tab.format === 'data'
    && tab.path.toLowerCase().endsWith('.kitable')
  ) {
    return {
      documentPath: String(tab.path || '').trim(),
      tableId: null,
    }
  }
  return null
}
