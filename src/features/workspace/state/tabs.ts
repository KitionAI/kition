/**
 * Pure tab-list transitions for the workspace tab strip.
 *
 * Every function takes the current `TabsState` and returns the next one
 * without side effects, so the rules (one logical tab per .kitable file,
 * active-tab fallback on close, path remaps after moves and renames) are
 * unit-testable and independent of React. `useWorkspaceTabs` applies them
 * and owns persistence and the workspace switch.
 */
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  getWorkspaceItemTitle,
  remapWorkspaceBranchPath,
} from '@/features/workspace/lib/workspace'

export type TabsState = {
  tabs: WorkspaceTab[]
  activeTabId: string
}

export const EMPTY_TABS_STATE: TabsState = { tabs: [], activeTabId: '' }

export type UpsertTabOptions = {
  activate?: boolean
  insertAfterActive?: boolean
}

/** Table, dashboard, workflow, and file tabs of one .kitable share a single logical tab. */
function getTabKitablePath(tab: WorkspaceTab): string {
  if (tab.type === 'table') return tab.kitablePath
  if (tab.type === 'dashboard') return tab.kitablePath
  if (tab.type === 'workflow') return tab.kitablePath || ''
  if (tab.type === 'document' && tab.path.toLowerCase().endsWith('.kitable')) return tab.path
  return ''
}

function isSameLogicalTab(candidate: WorkspaceTab, tab: WorkspaceTab, kitablePath: string) {
  return candidate.id === tab.id || (Boolean(kitablePath) && getTabKitablePath(candidate) === kitablePath)
}

/** Fallback active id after tabs at or around `removedIndex` disappear: the previous tab, else the first. */
function fallbackActiveId(next: WorkspaceTab[], removedIndex: number): string {
  const fallback = next[Math.max(0, removedIndex - 1)] || next[0]
  return fallback?.id || ''
}

export function upsertTab(state: TabsState, tab: WorkspaceTab, options: UpsertTabOptions = {}): TabsState {
  const kitablePath = getTabKitablePath(tab)
  const existingIndex = state.tabs.findIndex((item) => isSameLogicalTab(item, tab, kitablePath))
  let tabs: WorkspaceTab[]
  if (existingIndex >= 0) {
    const existing = state.tabs[existingIndex]
    const merged = existing.type === 'document' && tab.type === 'document'
      ? { ...tab, uid: tab.uid || existing.uid }
      : tab
    // Replace the first logical match in place and drop any other view of the same kitable.
    tabs = state.tabs.flatMap((item, index) => {
      if (!isSameLogicalTab(item, tab, kitablePath)) return [item]
      return index === existingIndex ? [merged] : []
    })
  } else if (options.insertAfterActive && state.activeTabId) {
    const activeIndex = state.tabs.findIndex((item) => item.id === state.activeTabId)
    tabs = activeIndex >= 0
      ? [...state.tabs.slice(0, activeIndex + 1), tab, ...state.tabs.slice(activeIndex + 1)]
      : [...state.tabs, tab]
  } else {
    tabs = [...state.tabs, tab]
  }
  return { tabs, activeTabId: options.activate === false ? state.activeTabId : tab.id }
}

export function updateTab(state: TabsState, tabId: string, updater: (tab: WorkspaceTab) => WorkspaceTab): TabsState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    changed = true
    return updater(tab)
  })
  return changed ? { ...state, tabs } : state
}

/** Removes one tab. Returns the closed tab so the caller can run its side effects after the state update. */
export function closeTab(state: TabsState, tabId: string): { state: TabsState; closed: WorkspaceTab | null } {
  const index = state.tabs.findIndex((item) => item.id === tabId)
  if (index < 0) return { state, closed: null }
  const tabs = state.tabs.filter((item) => item.id !== tabId)
  const activeTabId = state.activeTabId === tabId ? fallbackActiveId(tabs, index) : state.activeTabId
  return { state: { tabs, activeTabId }, closed: state.tabs[index] }
}

export function filterTabs(state: TabsState, predicate: (tab: WorkspaceTab) => boolean): TabsState {
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
  const tabs = state.tabs.filter(predicate)
  if (tabs.length === state.tabs.length) return state
  const activeTabId = state.activeTabId && !tabs.some((tab) => tab.id === state.activeTabId)
    ? fallbackActiveId(tabs, activeIndex)
    : state.activeTabId
  return { tabs, activeTabId }
}

/** After a move or folder rename, point document, board, design, and browser-origin tabs at the new path. */
export function remapTabPaths(state: TabsState, sourcePath: string, targetPath: string): TabsState {
  if (!sourcePath || !targetPath || sourcePath === targetPath) return state
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.type === 'document' || tab.type === 'board' || tab.type === 'design') {
      const nextPath = remapWorkspaceBranchPath(tab.path, sourcePath, targetPath)
      if (nextPath === tab.path) return tab
      changed = true
      const filename = nextPath.split('/').pop() || nextPath
      return {
        ...tab,
        id: `${tab.type}:${nextPath}`,
        path: nextPath,
        ...(tab.type !== 'document' ? { title: getWorkspaceItemTitle(filename) } : {}),
      }
    }
    if (tab.type === 'browser' && tab.originDocumentPath) {
      const nextOrigin = remapWorkspaceBranchPath(tab.originDocumentPath, sourcePath, targetPath)
      if (nextOrigin === tab.originDocumentPath) return tab
      changed = true
      return {
        ...tab,
        originDocumentPath: nextOrigin,
        originTabId: tab.originTabId === `document:${tab.originDocumentPath}`
          ? `document:${nextOrigin}`
          : tab.originTabId,
      }
    }
    return tab
  })
  const activeTabId = remapPathTabId(state.activeTabId, sourcePath, targetPath)
  return changed || activeTabId !== state.activeTabId ? { tabs, activeTabId } : state
}

function remapPathTabId(tabId: string, sourcePath: string, targetPath: string) {
  const prefix = (['design:', 'board:', 'document:'] as const).find((candidate) => tabId.startsWith(candidate))
  if (!prefix) return tabId
  const path = tabId.slice(prefix.length)
  const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
  return nextPath === path ? tabId : `${prefix}${nextPath}`
}

/** After a .kitable file rename, every view of that file collapses onto its new file-level tab. */
export function renameTabPath(state: TabsState, fromPath: string, toPath: string): TabsState {
  if (!fromPath || !toPath || fromPath === toPath) return state
  const kitableTabId = buildKitableWorkspaceTabId(toPath)
  const kitableTitle = getKitableWorkspaceTabTitle(toPath)
  let changed = false
  const remapped = state.tabs.map((tab) => {
    if ((tab.type === 'table' || tab.type === 'dashboard' || tab.type === 'workflow') && tab.kitablePath === fromPath) {
      changed = true
      return { ...tab, kitablePath: toPath, id: kitableTabId, title: kitableTitle }
    }
    if (tab.type === 'document' && tab.path === fromPath) {
      changed = true
      return { ...tab, path: toPath, id: `document:${toPath}` }
    }
    return tab
  })
  if (!changed) return state
  const seen = new Set<string>()
  const tabs = remapped.filter((tab) => {
    if (seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
  return { tabs, activeTabId: renameActiveTabId(state.activeTabId, fromPath, toPath) }
}

function renameActiveTabId(activeId: string, fromPath: string, toPath: string) {
  const kitableTabId = buildKitableWorkspaceTabId(toPath)
  if (activeId === buildKitableWorkspaceTabId(fromPath)) return kitableTabId
  if (activeId === `workflow:${fromPath}` || activeId.startsWith(`workflow:${fromPath}:`)) return kitableTabId
  if (activeId.startsWith(`table:${fromPath}#`)) return kitableTabId
  if (activeId === `document:${fromPath}`) return `document:${toPath}`
  return activeId
}

/**
 * Tab list to show after switching from one workspace to another. Tabs that
 * were not in the last committed state were added in the same React batch as
 * the root change (the new workspace's home document) and must survive; the
 * rest come from the target workspace's stored tabs.
 */
export function switchWorkspaceTabs(
  current: TabsState,
  stored: WorkspaceTab[],
  lastCommitted: TabsState,
): TabsState {
  const committedIds = new Set(lastCommitted.tabs.map((tab) => tab.id))
  const inBatchAdditions = current.tabs.filter((tab) => !committedIds.has(tab.id))
  const additionIds = new Set(inBatchAdditions.map((tab) => tab.id))
  const tabs = inBatchAdditions.length === 0
    ? stored
    : [...stored.filter((tab) => !additionIds.has(tab.id)), ...inBatchAdditions]
  const activeTabId = !current.activeTabId || current.activeTabId === lastCommitted.activeTabId
    ? stored[0]?.id || ''
    : current.activeTabId
  return { tabs, activeTabId }
}

/** First binding of a real root: stored tabs join whatever was opened before the registry resolved. */
export function bindInitialWorkspaceTabs(current: TabsState, stored: WorkspaceTab[]): TabsState {
  const existingIds = new Set(current.tabs.map((tab) => tab.id))
  const tabs = current.tabs.length === 0
    ? stored
    : [...stored.filter((tab) => !existingIds.has(tab.id)), ...current.tabs]
  return { tabs, activeTabId: current.activeTabId || stored[0]?.id || '' }
}
