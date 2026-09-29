/**
 * Query key factory. Keys are hierarchical so invalidation can target a
 * whole workspace, one document path, or one table without knowing which
 * hooks exist. Every key starts with the workspace root so switching
 * workspaces never serves cached data from another one.
 *
 * Conventions:
 *   ['workspace', root]                       everything under one root
 *   ['workspace', root, 'tree']               the file tree listing
 *   ['workspace', root, 'kitable-index']      table/dashboard/workflow leaves per .kitable
 *   ['workspace', root, 'document', path]     one document or data document by path
 *   ['workspace', root, 'records', ...]       record windows for one table
 *   ['runtime', 'workflows' | 'connections' | ...] workspace-independent runtime lists
 *   ['bundled', ...]                          assets packaged with the client
 */
export const queryKeys = {
  workspace: (root: string) => ['workspace', root] as const,
  workspaceTree: (root: string) => ['workspace', root, 'tree'] as const,
  kitableIndex: (root: string) => ['workspace', root, 'kitable-index'] as const,
  documentByPath: (root: string, path: string) => ['workspace', root, 'document', path] as const,
  records: (root: string, documentId: number, tableId: number, viewId?: number | null) =>
    ['workspace', root, 'records', documentId, tableId, viewId ?? null] as const,

  /** Bundled assets shipped with the client; independent of workspace and runtime. */
  designTemplates: () => ['bundled', 'design-templates'] as const,

  runtime: ['runtime'] as const,
  workflows: () => ['runtime', 'workflows'] as const,
  formSyncWorkflows: () => ['runtime', 'form-sync-workflows'] as const,
  emailSyncWorkflows: () => ['runtime', 'email-sync-workflows'] as const,
  connections: () => ['runtime', 'connections'] as const,
  agentSessions: () => ['runtime', 'agent-sessions'] as const,
  agentSession: (id: string) => ['runtime', 'agent-sessions', id] as const,
}

/**
 * Normalizes a workspace root so the same folder always maps to one key
 * even when callers pass it with a trailing slash or before it is known.
 */
export function workspaceRootKey(root: string | null | undefined): string {
  return (root ?? '').replace(/[\\/]+$/, '')
}
