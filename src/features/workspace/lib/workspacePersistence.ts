import type { WorkspaceDocumentFormat } from '@/services/desktop'
import {
  buildKitableWorkspaceTabId,
  getKitableWorkspaceTabTitle,
  type WorkspaceTab,
} from '@/features/workspace/lib/workspace'
import { buildWorkspaceBrowserTabTitle } from '@/features/workspace/lib/browserTabs'
import { WEB_BROWSER_ENABLED } from '@/lib/productFeatures'

export type WorkspaceTreeMetadata = {
  icons: Record<string, string>
  order: Record<string, string[]>
  collapsed: string[]
}

export type WorkspaceTreeMetadataMap = Record<string, WorkspaceTreeMetadata>

const workspaceTreeMetadataStorageKey = 'kition.document.tree.metadata.v2'
const workspaceSidebarWidthStorageKey = 'kition.document.sidebar.width.v1'
const agentSidebarWidthStorageKey = 'kition.document.agent-sidebar.width.v1'
const recentWorkspacePathsStorageKey = 'kition.document.recent.workspaces.v1'
const lastActiveWorkspacePathStorageKey = 'kition.document.last-active-path.v1'
const workspaceTabsStorageKey = 'kition.document.workspace-tabs.v2'
const legacyWorkspaceTabsStorageKey = 'kition.document.workspace-tabs.v1'
const workspaceAgentActiveSessionStorageKey =
  'kition.workspace.agent.active-session.v2'
const legacyWorkspaceAgentActiveSessionStorageKey =
  'kition.workspace.agent.active-session.v1'
const splitEditorRatioStorageKey = 'kition.document.split.ratio.v1'
const workspaceSidebarDefaultWidth = 276
const workspaceSidebarMinWidth = 220
const workspaceSidebarMaxWidth = 480
const agentSidebarDefaultWidth = 408
const agentSidebarMinWidth = 340
const agentSidebarMaxWidth = 720
const splitEditorDefaultRatio = 0.5
const splitEditorMinRatio = 0.15
const splitEditorMaxRatio = 0.85

export function getDefaultWorkspaceTreeMetadata(): WorkspaceTreeMetadata {
  return { icons: {}, order: {}, collapsed: [] }
}

function normalizeWorkspaceTreeMetadata(raw: unknown): WorkspaceTreeMetadata {
  if (!raw || typeof raw !== 'object') {
    return getDefaultWorkspaceTreeMetadata()
  }
  const candidate = raw as Partial<WorkspaceTreeMetadata>
  return {
    icons: candidate.icons && typeof candidate.icons === 'object' ? candidate.icons as Record<string, string> : {},
    order: candidate.order && typeof candidate.order === 'object' ? candidate.order as Record<string, string[]> : {},
    collapsed: Array.isArray(candidate.collapsed)
      ? candidate.collapsed.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

export function readWorkspaceTreeMetadataMap(): WorkspaceTreeMetadataMap {
  if (typeof window === 'undefined') {
    return {}
  }

  const rawValue = window.localStorage.getItem(workspaceTreeMetadataStorageKey)
  if (!rawValue) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawValue)
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const result: WorkspaceTreeMetadataMap = {}
    for (const [rootPath, bucket] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rootPath !== 'string') continue
      result[rootPath] = normalizeWorkspaceTreeMetadata(bucket)
    }
    return result
  } catch {
    return {}
  }
}

export function writeWorkspaceTreeMetadataMap(map: WorkspaceTreeMetadataMap) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(workspaceTreeMetadataStorageKey, JSON.stringify(map))
}

export function clampWorkspaceSidebarWidth(width: number) {
  return Math.min(workspaceSidebarMaxWidth, Math.max(workspaceSidebarMinWidth, Math.round(width)))
}

export function readWorkspaceSidebarWidth() {
  if (typeof window === 'undefined') {
    return workspaceSidebarDefaultWidth
  }

  const rawValue = window.localStorage.getItem(workspaceSidebarWidthStorageKey)
  if (!rawValue) {
    return workspaceSidebarDefaultWidth
  }

  const value = Number(rawValue)
  return Number.isFinite(value) ? clampWorkspaceSidebarWidth(value) : workspaceSidebarDefaultWidth
}

export function writeWorkspaceSidebarWidth(width: number) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(workspaceSidebarWidthStorageKey, String(clampWorkspaceSidebarWidth(width)))
}

export function clampSplitEditorRatio(ratio: number) {
  if (!Number.isFinite(ratio)) {
    return splitEditorDefaultRatio
  }
  return Math.min(splitEditorMaxRatio, Math.max(splitEditorMinRatio, ratio))
}

export function readSplitEditorRatio() {
  if (typeof window === 'undefined') {
    return splitEditorDefaultRatio
  }

  const rawValue = window.localStorage.getItem(splitEditorRatioStorageKey)
  if (!rawValue) {
    return splitEditorDefaultRatio
  }

  const value = Number(rawValue)
  return Number.isFinite(value) ? clampSplitEditorRatio(value) : splitEditorDefaultRatio
}

export function writeSplitEditorRatio(ratio: number) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(splitEditorRatioStorageKey, String(clampSplitEditorRatio(ratio)))
}

export function clampAgentSidebarWidth(width: number) {
  return Math.min(agentSidebarMaxWidth, Math.max(agentSidebarMinWidth, Math.round(width)))
}

export function readAgentSidebarWidth() {
  if (typeof window === 'undefined') {
    return agentSidebarDefaultWidth
  }

  const rawValue = window.localStorage.getItem(agentSidebarWidthStorageKey)
  if (!rawValue) {
    return agentSidebarDefaultWidth
  }

  const value = Number(rawValue)
  return Number.isFinite(value) ? clampAgentSidebarWidth(value) : agentSidebarDefaultWidth
}

export function writeAgentSidebarWidth(width: number) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(agentSidebarWidthStorageKey, String(clampAgentSidebarWidth(width)))
}

export function getWorkspaceDisplayName(rootPath: string) {
  const trimmedPath = rootPath.trim()
  if (!trimmedPath) {
    return 'Kition'
  }

  return trimmedPath.split(/[\\/]/).filter(Boolean).pop() || trimmedPath
}

export function readRecentWorkspacePaths(): string[] {
  if (typeof window === 'undefined') {
    return []
  }

  const rawValue = window.localStorage.getItem(recentWorkspacePathsStorageKey)
  if (!rawValue) {
    return []
  }

  try {
    const parsed = JSON.parse(rawValue)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 10) : []
  } catch {
    return []
  }
}

function writeRecentWorkspacePaths(paths: string[]) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(recentWorkspacePathsStorageKey, JSON.stringify(paths.slice(0, 10)))
}

export function rememberRecentWorkspacePath(rootPath: string) {
  const trimmedPath = rootPath.trim()
  if (!trimmedPath) {
    return readRecentWorkspacePaths()
  }

  const nextPaths = [trimmedPath, ...readRecentWorkspacePaths().filter((item) => item !== trimmedPath)].slice(0, 10)
  writeRecentWorkspacePaths(nextPaths)
  return nextPaths
}

export function readLastActiveDocumentPath() {
  if (typeof window === 'undefined') {
    return ''
  }

  return String(window.localStorage.getItem(lastActiveWorkspacePathStorageKey) || '').trim()
}

export function writeLastActiveDocumentPath(path: string) {
  if (typeof window === 'undefined') {
    return
  }

  const normalizedPath = String(path || '').trim()
  if (!normalizedPath) {
    window.localStorage.removeItem(lastActiveWorkspacePathStorageKey)
    return
  }

  window.localStorage.setItem(lastActiveWorkspacePathStorageKey, normalizedPath)
}

export function readWorkspaceTabs(rootPath: string): WorkspaceTab[] {
  if (typeof window === 'undefined') {
    return []
  }
  const key = String(rootPath || '').trim()
  if (!key) {
    return []
  }

  const rawMap = readWorkspaceTabsRawMap()
  const rawEntry = rawMap[key]
  if (Array.isArray(rawEntry)) {
    return parseWorkspaceTabList(rawEntry)
  }

  const legacyRaw = readLegacyWorkspaceTabsRawArray()
  if (legacyRaw && legacyRaw.length) {
    const nextRaw = { ...rawMap, [key]: legacyRaw }
    writeWorkspaceTabsRawMap(nextRaw)
    window.localStorage.removeItem(legacyWorkspaceTabsStorageKey)
    return parseWorkspaceTabList(legacyRaw)
  }
  if (window.localStorage.getItem(legacyWorkspaceTabsStorageKey) !== null) {
    // Legacy key exists but is unparseable/empty — drop it to stop reattempts.
    window.localStorage.removeItem(legacyWorkspaceTabsStorageKey)
  }
  return []
}

export function writeWorkspaceTabs(rootPath: string, tabs: WorkspaceTab[]) {
  if (typeof window === 'undefined') {
    return
  }
  const key = String(rootPath || '').trim()
  if (!key) {
    return
  }

  // Important: operate on the *raw* (unparsed) map so other workspaces' stored
  // entries pass through untouched. Going through parseWorkspaceTabList would
  // reformat their browser titles every write (originLabel/query get re-
  // appended), corrupting them over time.
  const rawMap = readWorkspaceTabsRawMap()
  if (tabs.length === 0) {
    if (!(key in rawMap)) {
      return
    }
    const { [key]: _omit, ...rest } = rawMap
    writeWorkspaceTabsRawMap(rest)
    return
  }
  writeWorkspaceTabsRawMap({ ...rawMap, [key]: tabs.slice(0, 12) as unknown[] })
}

type WorkspaceTabsRawMap = Record<string, unknown[]>

function readWorkspaceTabsRawMap(): WorkspaceTabsRawMap {
  if (typeof window === 'undefined') {
    return {}
  }
  const raw = window.localStorage.getItem(workspaceTabsStorageKey)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: WorkspaceTabsRawMap = {}
    for (const [rootPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rootPath !== 'string' || !rootPath) {
        continue
      }
      if (!Array.isArray(value)) {
        continue
      }
      result[rootPath] = value
    }
    return result
  } catch {
    return {}
  }
}

function writeWorkspaceTabsRawMap(map: WorkspaceTabsRawMap) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(workspaceTabsStorageKey, JSON.stringify(map))
}

function readLegacyWorkspaceTabsRawArray(): unknown[] | null {
  if (typeof window === 'undefined') {
    return null
  }
  const raw = window.localStorage.getItem(legacyWorkspaceTabsStorageKey)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseWorkspaceTabList(items: unknown[]): WorkspaceTab[] {
  const parsed = items.flatMap((raw): WorkspaceTab[] => {
    if (!raw || typeof raw !== 'object') {
      return []
    }
    const item = raw as Record<string, unknown>
    if (item.type === 'document' && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.path === 'string') {
      // Drop legacy document tabs pointing at .kitable files — those are now
      // opened as table: / workflow: virtual tabs. Keeping them would cause
      // the tab to try to load the raw JSON blob and fail on restore.
      if (item.path.toLowerCase().endsWith('.kitable')) {
        return []
      }
      return [{
        id: item.id,
        type: 'document',
        title: item.title,
        path: item.path,
        format: typeof item.format === 'string' ? item.format as WorkspaceDocumentFormat : undefined,
      }]
    }
    if (item.type === 'browser' && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.provider === 'string') {
      if (!WEB_BROWSER_ENABLED) {
        return []
      }
      const taskMode = item.taskMode === 'browse' || item.taskMode === 'table'
        ? item.taskMode
        : undefined
      const host = typeof item.host === 'string' ? item.host : undefined
      const url = typeof item.url === 'string' ? item.url : undefined
      const query = typeof item.query === 'string' ? item.query : undefined
      const originLabel = typeof item.originLabel === 'string' ? item.originLabel : undefined
      return [{
        id: item.id,
        type: 'browser',
        title: buildWorkspaceBrowserTabTitle({
          provider: item.provider,
          host,
          url,
          title: item.title,
          query,
          origin_label: originLabel,
        }),
        provider: item.provider,
        taskMode,
        host,
        url,
        query,
        profileId: typeof item.profileId === 'string' ? item.profileId : undefined,
        originTabId: typeof item.originTabId === 'string' ? item.originTabId : undefined,
        originDocumentPath: typeof item.originDocumentPath === 'string' ? item.originDocumentPath : undefined,
        originTableId: Number.isFinite(Number(item.originTableId))
          ? Number(item.originTableId)
          : undefined,
        originLabel,
      }]
    }
    if (item.type === 'gallery' && typeof item.id === 'string' && typeof item.title === 'string' && item.kind === 'videos') {
      return [{
        id: item.id,
        type: 'gallery',
        title: item.title,
        kind: item.kind,
      }]
    }
    if (item.type === 'table'
      && typeof item.id === 'string'
      && typeof item.title === 'string'
      && typeof item.kitablePath === 'string'
      && item.kitablePath.length > 0
      && Number.isInteger(item.tableId)
      && (item.tableId as number) > 0
    ) {
      return [{
        id: buildKitableWorkspaceTabId(item.kitablePath),
        type: 'table',
        title: getKitableWorkspaceTabTitle(item.kitablePath),
        kitablePath: item.kitablePath,
        tableId: item.tableId as number,
        format: 'data',
      }]
    }
    if (item.type === 'dashboard'
      && typeof item.id === 'string'
      && typeof item.title === 'string'
      && typeof item.kitablePath === 'string'
      && item.kitablePath.length > 0
      && typeof item.dashboardId === 'string'
      && item.dashboardId.length > 0
    ) {
      return [{
        id: buildKitableWorkspaceTabId(item.kitablePath),
        type: 'dashboard',
        title: getKitableWorkspaceTabTitle(item.kitablePath),
        kitablePath: item.kitablePath,
        dashboardId: item.dashboardId,
        format: 'data',
      }]
    }
    if (item.type === 'workflow' && typeof item.id === 'string' && typeof item.title === 'string') {
      const kitablePath = typeof item.kitablePath === 'string' && item.kitablePath.length > 0
        ? item.kitablePath
        : undefined
      const workflowId = typeof item.workflowId === 'string' && item.workflowId.length > 0
        ? item.workflowId
        : undefined
      return [{
        id: kitablePath ? buildKitableWorkspaceTabId(kitablePath) : item.id,
        type: 'workflow',
        title: kitablePath ? getKitableWorkspaceTabTitle(kitablePath) : item.title,
        ...(kitablePath ? { kitablePath } : {}),
        ...(workflowId ? { workflowId } : {}),
      }]
    }
    if (item.type === 'browser-sites') {
      // Browser sites is rendered inside the sidebar tab now; drop any legacy persisted tab.
      return []
    }
    return []
  })
  const indexById = new Map<string, number>()
  const deduped: WorkspaceTab[] = []
  for (const tab of parsed) {
    const existingIndex = indexById.get(tab.id)
    if (existingIndex == null) {
      indexById.set(tab.id, deduped.length)
      deduped.push(tab)
    } else {
      deduped[existingIndex] = tab
    }
  }
  return deduped
}

type WorkspaceAgentActiveSessionMap = Record<string, number>

function readWorkspaceAgentActiveSessionMap(): WorkspaceAgentActiveSessionMap {
  if (typeof window === 'undefined') {
    return {}
  }
  const raw = window.localStorage.getItem(workspaceAgentActiveSessionStorageKey)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: WorkspaceAgentActiveSessionMap = {}
    for (const [rootPath, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof rootPath !== 'string' || !rootPath) {
        continue
      }
      const sessionId = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(sessionId) && sessionId > 0) {
        result[rootPath] = sessionId
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeWorkspaceAgentActiveSessionMap(map: WorkspaceAgentActiveSessionMap) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(
    workspaceAgentActiveSessionStorageKey,
    JSON.stringify(map),
  )
}

export function readWorkspaceAgentActiveSessionId(rootPath: string): number | null {
  if (typeof window === 'undefined') {
    return null
  }
  const key = String(rootPath || '').trim()
  if (!key) {
    return null
  }
  const map = readWorkspaceAgentActiveSessionMap()
  if (key in map) {
    return map[key]
  }
  // Legacy single-value key predates per-workspace bucketing. Pull it over
  // into the first workspace that asks so users keep their last chat focus
  // after upgrade, then retire the old key.
  const legacy = window.localStorage.getItem(legacyWorkspaceAgentActiveSessionStorageKey)
  window.localStorage.removeItem(legacyWorkspaceAgentActiveSessionStorageKey)
  const legacyId = Number(legacy || 0)
  if (Number.isFinite(legacyId) && legacyId > 0) {
    writeWorkspaceAgentActiveSessionMap({ ...map, [key]: legacyId })
    return legacyId
  }
  return null
}

export function writeWorkspaceAgentActiveSessionId(
  rootPath: string,
  sessionId: number | null,
) {
  if (typeof window === 'undefined') {
    return
  }
  const key = String(rootPath || '').trim()
  if (!key) {
    return
  }
  const map = readWorkspaceAgentActiveSessionMap()
  if (!sessionId || sessionId <= 0) {
    if (!(key in map)) {
      return
    }
    const { [key]: _omit, ...rest } = map
    writeWorkspaceAgentActiveSessionMap(rest)
    return
  }
  writeWorkspaceAgentActiveSessionMap({ ...map, [key]: sessionId })
}
