/**
 * Pure tab-list transitions for the workspace tab strip.
 *
 * Every function takes the current `TabsState` and returns the next one
 * without side effects, so the rules (one tab per id, active-tab fallback on close, path remaps after moves and renames) are
 * unit-testable and independent of React. `useWorkspaceTabs` applies them
 * and owns persistence and the workspace switch.
 */
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'
import { getWorkspaceItemTitle, remapWorkspaceBranchPath } from '@/features/workspace/lib/workspace'

export type TabsState = {
  tabs: WorkspaceTab[]
  activeTabId: string
}

export const EMPTY_TABS_STATE: TabsState = { tabs: [], activeTabId: '' }

export type UpsertTabOptions = {
  activate?: boolean
  insertAfterActive?: boolean
}

/** Fallback active id after tabs at or around `removedIndex` disappear: the previous tab, else the first. */
function fallbackActiveId(next: WorkspaceTab[], removedIndex: number): string {
  const fallback = next[Math.max(0, removedIndex - 1)] || next[0]
  return fallback?.id || ''
}

export function upsertTab(state: TabsState, tab: WorkspaceTab, options: UpsertTabOptions = {}): TabsState {
  const existingIndex = state.tabs.findIndex((item) => item.id === tab.id)
  let tabs: WorkspaceTab[]
  if (existingIndex >= 0) {
    tabs = state.tabs.map((item, index) => (index === existingIndex ? tab : item))
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

/** After a move or folder rename, point file and design tabs at the new path. */
export function remapTabPaths(state: TabsState, sourcePath: string, targetPath: string): TabsState {
  if (!sourcePath || !targetPath || sourcePath === targetPath) return state
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.type === 'file-viewer' || tab.type === 'design') {
      const nextPath = remapWorkspaceBranchPath(tab.path, sourcePath, targetPath)
      if (nextPath === tab.path) return tab
      changed = true
      const filename = nextPath.split('/').pop() || nextPath
      return { ...tab, id: `${tab.type}:${nextPath}`, path: nextPath, title: getWorkspaceItemTitle(filename) }
    }
    return tab
  })
  const activeTabId = remapPathTabId(state.activeTabId, sourcePath, targetPath)
  return changed || activeTabId !== state.activeTabId ? { tabs, activeTabId } : state
}

function remapPathTabId(tabId: string, sourcePath: string, targetPath: string) {
  const prefix = (['design:', 'file-viewer:'] as const).find((candidate) => tabId.startsWith(candidate))
  if (!prefix) return tabId
  const path = tabId.slice(prefix.length)
  const nextPath = remapWorkspaceBranchPath(path, sourcePath, targetPath)
  return nextPath === path ? tabId : `${prefix}${nextPath}`
}

/** After a table file rename, its workflow tab and its file tab follow the file. */
export function renameTabPath(state: TabsState, fromPath: string, toPath: string): TabsState {
  if (!fromPath || !toPath || fromPath === toPath) return state
  let changed = false
  const remapped = state.tabs.map((tab) => {
    if (tab.type === 'workflow' && tab.tablePath === fromPath) {
      changed = true
      return { ...tab, tablePath: toPath, id: `workflow:${toPath}` }
    }
    if (tab.type === 'file-viewer' && tab.path === fromPath) {
      changed = true
      return { ...tab, path: toPath, id: `file-viewer:${toPath}` }
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
  if (activeId === `workflow:${fromPath}`) return `workflow:${toPath}`
  if (activeId === `file-viewer:${fromPath}`) return `file-viewer:${toPath}`
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
