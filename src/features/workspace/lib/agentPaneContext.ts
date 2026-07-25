import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
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
