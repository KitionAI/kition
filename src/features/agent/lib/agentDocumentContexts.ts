const agentDocumentContextsStorageKey = 'kition.agent.document-contexts.v1'

export type AgentDocumentContextPaths = string[]

type StoredAgentDocumentContexts = Record<string, Record<string, unknown>>

export function resolveAgentDocumentContextPaths(
  contexts: Record<number, AgentDocumentContextPaths>,
  sessionId: number,
  automaticPath: string,
) {
  if (!Object.prototype.hasOwnProperty.call(contexts, sessionId)) {
    return normalizeAgentDocumentContextPaths([automaticPath])
  }
  return normalizeAgentDocumentContextPaths(contexts[sessionId])
}

export function resolveAgentDocumentContextPath(
  contexts: Record<number, AgentDocumentContextPaths>,
  sessionId: number,
  automaticPath: string,
) {
  return resolveAgentDocumentContextPaths(contexts, sessionId, automaticPath)[0] || ''
}

export function readAgentDocumentContextsForWorkspace(rootPath: string) {
  const workspaceKey = String(rootPath || '').trim()
  if (!workspaceKey) {
    return {}
  }
  const stored = readStoredAgentDocumentContexts()[workspaceKey] || {}
  const result: Record<number, AgentDocumentContextPaths> = {}
  for (const [sessionId, context] of Object.entries(stored)) {
    const normalizedSessionId = Number(sessionId)
    if (!Number.isFinite(normalizedSessionId) || normalizedSessionId <= 0) {
      continue
    }
    if (context === null) {
      result[normalizedSessionId] = []
      continue
    }
    const paths = normalizeAgentDocumentContextPaths(
      Array.isArray(context) ? context : [context],
    )
    if (paths.length || Array.isArray(context)) {
      result[normalizedSessionId] = paths
    }
  }
  return result
}

export function writeAgentDocumentContextsForSession(
  rootPath: string,
  sessionId: number,
  paths: AgentDocumentContextPaths | undefined,
) {
  if (typeof window === 'undefined') {
    return
  }
  const workspaceKey = String(rootPath || '').trim()
  if (!workspaceKey || !Number.isFinite(sessionId) || sessionId <= 0) {
    return
  }
  const stored = readStoredAgentDocumentContexts()
  const workspaceContexts = { ...(stored[workspaceKey] || {}) }
  if (paths === undefined) {
    delete workspaceContexts[String(sessionId)]
  } else {
    workspaceContexts[String(sessionId)] = normalizeAgentDocumentContextPaths(paths)
  }
  if (Object.keys(workspaceContexts).length) {
    stored[workspaceKey] = workspaceContexts
  } else {
    delete stored[workspaceKey]
  }
  window.localStorage.setItem(agentDocumentContextsStorageKey, JSON.stringify(stored))
}

export function normalizeAgentDocumentContextPaths(paths: unknown) {
  if (!Array.isArray(paths)) {
    return []
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const rawPath of paths) {
    const path = String(rawPath || '').trim()
    if (!path || seen.has(path)) {
      continue
    }
    seen.add(path)
    result.push(path)
  }
  return result
}

function readStoredAgentDocumentContexts(): StoredAgentDocumentContexts {
  if (typeof window === 'undefined') {
    return {}
  }
  const raw = window.localStorage.getItem(agentDocumentContextsStorageKey)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as StoredAgentDocumentContexts
      : {}
  } catch {
    return {}
  }
}
