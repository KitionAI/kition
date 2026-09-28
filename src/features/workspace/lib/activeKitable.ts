/**
 * Which .kitable container the active tab belongs to, and which of its
 * sections the container sidebar highlights.
 */
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import type { WorkspaceDocumentFormat } from '@/services/desktop'

export type KitableSidebarMode = 'dashboard' | 'table' | 'workflow'

/** The .kitable path of the active tab, or '' when the tab is not inside one. */
export function resolveActiveKitablePath(
  tab: WorkspaceTab | null | undefined,
  activeDocumentFormat: WorkspaceDocumentFormat | null | undefined,
) {
  if (!tab) return ''
  if (tab.type === 'table' || tab.type === 'dashboard') return tab.kitablePath
  if (tab.type === 'workflow') return tab.kitablePath || ''
  if (tab.type === 'document' && activeDocumentFormat === 'data' && tab.path.toLowerCase().endsWith('.kitable')) {
    return tab.path
  }
  return ''
}

export function resolveKitableSidebarMode(tab: WorkspaceTab | null | undefined, workflowOpen: boolean): KitableSidebarMode {
  if (workflowOpen || tab?.type === 'workflow') return 'workflow'
  if (tab?.type === 'dashboard') return 'dashboard'
  return 'table'
}
