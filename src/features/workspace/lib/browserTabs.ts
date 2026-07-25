import type { BrowserSessionProvider } from '@/services/desktop'
import type { WorkspaceTab } from '@/features/workspace/lib/workspace'

export const OPEN_WORKSPACE_BROWSER_TAB_EVENT =
  'kition:workspace-browser-tab'

export type WorkspaceBrowserTabPayload = {
  provider: BrowserSessionProvider
  profile_id?: string
  task_mode?: 'auto' | 'browse' | 'table'
  host?: string
  url?: string
  title?: string
  query?: string
  activate?: boolean
  insertAfterActive?: boolean
  origin_tab_id?: string
  origin_document_path?: string
  origin_table_id?: number
  origin_label?: string
}

export type WorkspaceBrowserSessionSnapshot = WorkspaceBrowserTabPayload

export function resolveWorkspaceBrowserTabOrigin(
  payload: WorkspaceBrowserTabPayload,
  fallback?: {
    documentPath?: string
    tableId?: number | null
    originLabel?: string
  },
) {
  const originDocumentPath = String(
    payload.origin_document_path || fallback?.documentPath || '',
  ).trim()
  const originTabId = String(
    payload.origin_tab_id ||
      (originDocumentPath ? `document:${originDocumentPath}` : ''),
  ).trim()
  const originLabel = String(
    payload.origin_label || fallback?.originLabel || '',
  ).trim()
  const fallbackTableId =
    typeof fallback?.tableId === 'number' ? fallback.tableId : undefined
  const originTableId =
    typeof payload.origin_table_id === 'number'
      ? payload.origin_table_id
      : fallbackTableId

  return {
    originDocumentPath,
    originTabId,
    originLabel,
    originTableId,
  }
}

function formatWorkspaceBrowserTabLabel(
  input: Pick<
    WorkspaceBrowserSessionSnapshot,
    'host' | 'url' | 'provider' | 'title' | 'query' | 'origin_label'
  >,
) {
  const host = resolveWorkspaceBrowserHost(input)
  const explicit = normalizeWorkspaceBrowserExplicitTitle(input.title)
  const query = String(input.query || '').trim()
  const provider = String(input.provider || '').trim()
  const base =
    host ||
    (provider && provider !== 'generic-web' ? provider : '') ||
    'browser'
  const originLabel = String(input.origin_label || '').trim()
  const combined = [base, explicit].filter(Boolean).join(' ').toLowerCase()
  const queryAlreadyPresent =
    query &&
    combined.includes(query.toLowerCase())

  const suffixParts: string[] = []
  if (originLabel) {
    suffixParts.push(originLabel)
  }
  if (query && !queryAlreadyPresent) {
    suffixParts.push(query)
  }

  if (!explicit) {
    return suffixParts.length
      ? `${base} · ${suffixParts.join(' · ')}`
      : base
  }
  if (!host && (!provider || provider === 'generic-web')) {
    return suffixParts.length
      ? `${explicit} · ${suffixParts.join(' · ')}`
      : explicit
  }
  if (
    explicit.toLowerCase() === base.toLowerCase() ||
    explicit.toLowerCase().includes(base.toLowerCase())
  ) {
    return suffixParts.length
      ? `${explicit} · ${suffixParts.join(' · ')}`
      : explicit
  }
  return suffixParts.length
    ? `${base} · ${suffixParts.join(' · ')} · ${explicit}`
    : `${base} · ${explicit}`
}

function normalizeWorkspaceBrowserExplicitTitle(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const withoutPrefix = raw.replace(/^(\s*\[web\]\s*)+/i, '').trim()
  if (!withoutPrefix) {
    return ''
  }

  const parts = withoutPrefix
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)

  if (!parts.length) {
    return withoutPrefix
  }

  const deduped: string[] = []
  for (const part of parts) {
    if (deduped.at(-1)?.toLowerCase() === part.toLowerCase()) {
      continue
    }
    deduped.push(part)
  }

  return deduped.join(' · ')
}

function normalizeBrowserHost(value: string) {
  const trimmed = String(value || '').trim().toLowerCase()
  if (!trimmed) {
    return ''
  }
  const rawHost = trimmed.replace(/^https?:\/\//, '').split('/')[0] || ''
  return rawHost.replace(/^www\./, '')
}

function normalizeBrowserURL(value: string) {
  const rawValue = String(value || '').trim()
  if (!rawValue) {
    return ''
  }
  try {
    const url = new URL(rawValue)
    url.hash = ''
    return url.toString()
  } catch {
    return rawValue
  }
}

export function resolveWorkspaceBrowserHost(
  input: Pick<WorkspaceBrowserSessionSnapshot, 'host' | 'url'>,
) {
  const explicitHost = normalizeBrowserHost(String(input.host || ''))
  if (explicitHost) {
    return explicitHost
  }
  const rawURL = String(input.url || '').trim()
  if (!rawURL) {
    return ''
  }
  try {
    return normalizeBrowserHost(new URL(rawURL).hostname)
  } catch {
    return ''
  }
}

export function buildWorkspaceBrowserTabId(
  input: WorkspaceBrowserTabPayload,
) {
  const provider = String(input.provider || '').trim() || 'generic-web'
  const profileId = String(input.profile_id || '').trim()
  const originTabId = String(input.origin_tab_id || '').trim()
  const originDocumentPath = String(input.origin_document_path || '').trim()
  const host = resolveWorkspaceBrowserHost(input)
  if (profileId) {
    return `browser:${provider}:${profileId}`
  }
  const originKey = originTabId || originDocumentPath
  const siteKey = host || provider
  const key = originKey
    ? `${siteKey}:${originKey}`
    : siteKey
  return `browser:${provider}:${key}`
}

export function buildWorkspaceBrowserTabTitle(
  input: WorkspaceBrowserTabPayload,
) {
  return formatWorkspaceBrowserTabLabel(input)
}

export function resolveWorkspaceBrowserTabNavigationURL(input: {
  tabURL?: string
  liveURL?: string
}) {
  const tabURL = String(input.tabURL || '').trim()
  if (tabURL) {
    return tabURL
  }
  return String(input.liveURL || '').trim()
}

export function findLinkedWorkspaceTabIds(
  tabs: WorkspaceTab[],
  activeTabId: string,
) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  if (!activeTab) {
    return []
  }

  const linkedIds = new Set<string>()

  if (activeTab.type === 'browser') {
    const originTabId = String(activeTab.originTabId || '').trim()
    if (originTabId) {
      linkedIds.add(originTabId)
    }
    return Array.from(linkedIds)
  }

  if (activeTab.type !== 'document') {
    return []
  }

  for (const tab of tabs) {
    if (tab.type !== 'browser') {
      continue
    }
    if (String(tab.originTabId || '').trim() === activeTab.id) {
      linkedIds.add(tab.id)
    }
  }

  return Array.from(linkedIds)
}

export function doesWorkspaceBrowserTabMatchSnapshot(
  tab: WorkspaceTab,
  snapshot: WorkspaceBrowserSessionSnapshot,
) {
  if (tab.type !== 'browser') {
    return false
  }
  const provider = String(snapshot.provider || '').trim().toLowerCase()
  if (!provider || String(tab.provider || '').trim().toLowerCase() !== provider) {
    return false
  }

  const profileId = String(snapshot.profile_id || '').trim()
  if (profileId && String(tab.profileId || '').trim() === profileId) {
    return true
  }

  const snapshotURL = normalizeBrowserURL(String(snapshot.url || ''))
  const tabURL = normalizeBrowserURL(String(tab.url || ''))
  if (snapshotURL && tabURL && snapshotURL === tabURL) {
    return true
  }

  const snapshotHost = resolveWorkspaceBrowserHost(snapshot)
  const tabHost = resolveWorkspaceBrowserHost({
    host: tab.host,
    url: tab.url,
  })
  if (snapshotHost && tabHost && snapshotHost === tabHost) {
    return true
  }

  return false
}

export function applyWorkspaceBrowserSessionSnapshot(
  tab: WorkspaceTab,
  snapshot: WorkspaceBrowserSessionSnapshot,
) {
  if (tab.type !== 'browser') {
    return tab
  }
  const nextHost = resolveWorkspaceBrowserHost(snapshot) || tab.host
  const nextURL = String(snapshot.url || '').trim() || tab.url
  const nextTitle = formatWorkspaceBrowserTabLabel({
    provider: snapshot.provider || tab.provider,
    host: nextHost || tab.host,
    url: nextURL || tab.url,
    title: snapshot.title || tab.title,
    query: snapshot.query || tab.query,
    origin_label: snapshot.origin_label || tab.originLabel,
  })

  if (
    nextHost === tab.host &&
    nextURL === tab.url &&
    nextTitle === tab.title
  ) {
    return tab
  }

  return {
    ...tab,
    host: nextHost,
    url: nextURL,
    query: String(snapshot.query || '').trim() || tab.query,
    title: nextTitle,
    originTabId:
      String(snapshot.origin_tab_id || '').trim() || tab.originTabId,
    originDocumentPath:
      String(snapshot.origin_document_path || '').trim() || tab.originDocumentPath,
    originTableId:
      typeof snapshot.origin_table_id === 'number'
        ? snapshot.origin_table_id
        : tab.originTableId,
    originLabel:
      String(snapshot.origin_label || '').trim() || tab.originLabel,
  }
}

export function findWorkspaceBrowserTabIdsForSnapshot(
  tabs: WorkspaceTab[],
  snapshot: WorkspaceBrowserSessionSnapshot,
) {
  const exactMatches = tabs
    .filter((tab) => doesWorkspaceBrowserTabMatchSnapshot(tab, snapshot))
    .map((tab) => tab.id)
  if (exactMatches.length === 1) {
    return exactMatches
  }
  if (exactMatches.length > 1) {
    return []
  }

  const provider = String(snapshot.provider || '').trim().toLowerCase()
  if (!provider) {
    return []
  }
  const providerMatches = tabs.filter(
    (tab) =>
      tab.type === 'browser' &&
      String(tab.provider || '').trim().toLowerCase() === provider,
  )
  return providerMatches.length === 1 ? [providerMatches[0].id] : []
}

export function dispatchOpenWorkspaceBrowserTab(
  payload: WorkspaceBrowserTabPayload,
) {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(
    new CustomEvent<WorkspaceBrowserTabPayload>(
      OPEN_WORKSPACE_BROWSER_TAB_EVENT,
      { detail: payload },
    ),
  )
}
