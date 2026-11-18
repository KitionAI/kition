import type { AgentLocalSource } from '@/api/agent'

const agentLocalSourcesStorageKey = 'kition.agent.local-sources.v1'

type StoredAgentLocalSources = Record<string, Record<string, AgentLocalSource[]>>

const localPathReferencePattern = /(?<![A-Za-z0-9:/\\])((?:\.\.?(?:[\\/])|~[\\/]|[A-Za-z]:[\\/]|\/(?!\/))[^\s'"`，。；;、)）\]】]+)/g
const localPathReferenceNaturalLanguageSuffixes = [
  String.fromCodePoint(0x91cc, 0x9762, 0x7684),
  String.fromCodePoint(0x91cc, 0x7684),
  String.fromCodePoint(0x4e2d, 0x7684),
  String.fromCodePoint(0x4e0b, 0x7684),
]

export function extractAgentLocalPathReference(content: string) {
  localPathReferencePattern.lastIndex = 0
  const match = localPathReferencePattern.exec(String(content || ''))
  let value = match?.[1] || ''
  let boundary = value.length
  for (const suffix of localPathReferenceNaturalLanguageSuffixes) {
    const index = value.indexOf(suffix)
    if (index >= 0 && index < boundary) {
      boundary = index
    }
  }
  value = value.slice(0, boundary)
  return value.replace(/[.!?！？。:：]+$/g, '')
}

export function appendAgentLocalSource(
  sources: AgentLocalSource[],
  source: AgentLocalSource,
) {
  if (sources.some((item) => item.root_path === source.root_path)) {
    return sources
  }
  return [...sources, source].slice(0, 8)
}

export function readAgentLocalSourcesForWorkspace(rootPath: string) {
  const workspaceKey = String(rootPath || '').trim()
  if (!workspaceKey) {
    return {}
  }
  const stored = readStoredAgentLocalSources()[workspaceKey] || {}
  const result: Record<number, AgentLocalSource[]> = {}
  for (const [sessionId, sources] of Object.entries(stored)) {
    const normalizedSessionId = Number(sessionId)
    if (!Number.isFinite(normalizedSessionId) || normalizedSessionId <= 0) {
      continue
    }
    const normalizedSources = normalizeAgentLocalSources(sources)
    if (normalizedSources.length) {
      result[normalizedSessionId] = normalizedSources
    }
  }
  return result
}

export function writeAgentLocalSourcesForSession(
  rootPath: string,
  sessionId: number,
  sources: AgentLocalSource[],
) {
  if (typeof window === 'undefined') {
    return
  }
  const workspaceKey = String(rootPath || '').trim()
  if (!workspaceKey || !Number.isFinite(sessionId) || sessionId <= 0) {
    return
  }
  const stored = readStoredAgentLocalSources()
  const workspaceSources = { ...(stored[workspaceKey] || {}) }
  const normalizedSources = normalizeAgentLocalSources(sources)
  if (normalizedSources.length) {
    workspaceSources[String(sessionId)] = normalizedSources
  } else {
    delete workspaceSources[String(sessionId)]
  }
  if (Object.keys(workspaceSources).length) {
    stored[workspaceKey] = workspaceSources
  } else {
    delete stored[workspaceKey]
  }
  window.localStorage.setItem(agentLocalSourcesStorageKey, JSON.stringify(stored))
}

function readStoredAgentLocalSources(): StoredAgentLocalSources {
  if (typeof window === 'undefined') {
    return {}
  }
  const raw = window.localStorage.getItem(agentLocalSourcesStorageKey)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StoredAgentLocalSources
      : {}
  } catch {
    return {}
  }
}

function normalizeAgentLocalSources(sources: unknown): AgentLocalSource[] {
  if (!Array.isArray(sources)) {
    return []
  }
  const result: AgentLocalSource[] = []
  const seenPaths = new Set<string>()
  for (const raw of sources) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const candidate = raw as Partial<AgentLocalSource>
    const id = String(candidate.id || '').trim()
    const label = String(candidate.label || '').trim()
    const rootPath = String(candidate.root_path || '').trim()
    if (!id || !label || !rootPath || candidate.access !== 'read' || seenPaths.has(rootPath)) {
      continue
    }
    result.push({ id, label, root_path: rootPath, access: 'read' })
    seenPaths.add(rootPath)
    if (result.length >= 8) {
      break
    }
  }
  return result
}
