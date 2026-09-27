/**
 * Bridges the app's change signals to query invalidation so views refresh
 * without hand-rolled refetch calls.
 *
 * Signals:
 * - File watcher events from the desktop process (add / change / unlink),
 *   scoped to the changed path and, for .kitable files, the kitable index.
 * - `kition:workspace-reload`, the manual "re-read the tree" event.
 * - The runtime change events dispatched by the API modules after a write
 *   (workflows, form sync, email sync, connections).
 */
import type { QueryClient } from '@tanstack/react-query'

import { queryKeys, workspaceRootKey } from '@/api/queryKeys'
import { subscribeWorkspaceDocumentExternalChanges, type WorkspaceDocumentExternalChange } from '@/services/desktop'
import { WORKFLOW_CHANGED_EVENT, WORKFLOW_ENABLED_CHANGED_EVENT } from '@/lib/workflowEvents'
import { CONNECTIONS_CHANGED_EVENT } from './connections'
import { EMAIL_SYNC_CHANGED_EVENT } from './emailSync'
import { FORM_SYNC_CHANGED_EVENT } from './formSync'

export const WORKSPACE_RELOAD_EVENT = 'kition:workspace-reload'

let currentWorkspaceRoot = ''

/** Called when the active workspace root changes so path-scoped keys resolve. */
export function setInvalidationWorkspaceRoot(root: string | null | undefined) {
  currentWorkspaceRoot = workspaceRootKey(root)
}

function isKitablePath(path: string) {
  return path.toLowerCase().endsWith('.kitable')
}

/** Invalidates the queries that a single file change can affect. */
export function invalidateForWorkspaceChange(queryClient: QueryClient, change: WorkspaceDocumentExternalChange) {
  const root = currentWorkspaceRoot
  const tasks = [
    queryClient.invalidateQueries({ queryKey: queryKeys.documentByPath(root, change.path) }),
  ]
  if (change.eventType !== 'change') {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTree(root) }))
  }
  if (isKitablePath(change.path)) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.kitableIndex(root) }))
  }
  return Promise.all(tasks)
}

function invalidateWorkspace(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.workspace(currentWorkspaceRoot) })
}

function invalidateWorkflows(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.workflows() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.formSyncWorkflows() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.kitableIndex(currentWorkspaceRoot) }),
  ])
}

/**
 * Subscribes the query client to every change signal. Returns a disposer.
 * Safe to call in a browser preview: the watcher subscription is a no-op
 * when no desktop bridge is present.
 */
export function installWorkspaceInvalidation(queryClient: QueryClient) {
  const disposers: Array<() => void> = []

  disposers.push(subscribeWorkspaceDocumentExternalChanges((change) => {
    void invalidateForWorkspaceChange(queryClient, change)
  }))

  if (typeof window !== 'undefined') {
    const listen = (event: string, handler: () => void) => {
      window.addEventListener(event, handler)
      disposers.push(() => window.removeEventListener(event, handler))
    }
    listen(WORKSPACE_RELOAD_EVENT, () => { void invalidateWorkspace(queryClient) })
    listen(WORKFLOW_CHANGED_EVENT, () => { void invalidateWorkflows(queryClient) })
    listen(WORKFLOW_ENABLED_CHANGED_EVENT, () => { void invalidateWorkflows(queryClient) })
    listen(FORM_SYNC_CHANGED_EVENT, () => { void invalidateWorkflows(queryClient) })
    listen(EMAIL_SYNC_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.emailSyncWorkflows() })
    })
    listen(CONNECTIONS_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections() })
    })
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}
