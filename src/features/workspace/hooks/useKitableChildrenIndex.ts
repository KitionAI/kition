import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { listDataDocuments } from '@/api/dataDocuments'
import { readDataDashboards } from '@/features/dashboard/lib/dashboardMetadata'
import { listWorkflows } from '@/api/workflows'
import { listFormSyncWorkflows } from '@/features/formSync/api'
import { queryKeys, workspaceRootKey } from '@/api/queryKeys'
import type {
  KitableDashboardSummary,
  KitableWorkflowSummary,
  KitableTableSummary,
} from '@/features/workspace/lib/workspaceTree'
import { isWebPreviewMode } from '@/lib/runtimeMode'

export type KitableChildrenIndex = {
  status: 'idle' | 'loading' | 'done' | 'error'
  tablesByKitablePath: Record<string, KitableTableSummary[]>
  dashboardsByKitablePath: Record<string, KitableDashboardSummary[]>
  workflowsByKitablePath: Record<string, KitableWorkflowSummary[]>
  docIdByKitablePath: Record<string, string>
  error: string | null
  refresh: () => Promise<void>
  // Rekeys the cached maps when a .kitable file is renamed/moved on disk.
  // The next refetch will pick up the new path from the backend, but the
  // tree depends on this lookup *synchronously* to render virtual children —
  // without the rekey, the kitable's table/workflow leaves vanish until the
  // backend list call returns.
  renameKitablePath: (fromPath: string, toPath: string) => void
}

type KitableChildrenSnapshot = Pick<
  KitableChildrenIndex,
  'tablesByKitablePath' | 'dashboardsByKitablePath' | 'workflowsByKitablePath' | 'docIdByKitablePath'
>

const EMPTY_SNAPSHOT: KitableChildrenSnapshot = {
  tablesByKitablePath: {},
  dashboardsByKitablePath: {},
  workflowsByKitablePath: {},
  docIdByKitablePath: {},
}

async function settled<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load()
  } catch {
    return fallback
  }
}

/** Builds the per-kitable index from the runtime's documents and workflow lists. */
async function loadKitableChildrenSnapshot(rootPath?: string): Promise<KitableChildrenSnapshot> {
  if (isWebPreviewMode()) return EMPTY_SNAPSHOT
  const [docs, workflows, formWorkflows] = await Promise.all([
    listDataDocuments(rootPath ? { workspace_root: rootPath } : undefined),
    settled(listWorkflows, []),
    settled(listFormSyncWorkflows, []),
  ])
  const tablesByKitablePath: Record<string, KitableTableSummary[]> = {}
  const dashboardsByKitablePath: Record<string, KitableDashboardSummary[]> = {}
  const kitablePathByDocId: Record<string, string> = {}
  const docIdByKitablePath: Record<string, string> = {}
  for (const doc of docs.items || []) {
    const path = String(doc.path || '').trim()
    if (!path.toLowerCase().endsWith('.kitable')) continue
    const docId = String(doc.id)
    kitablePathByDocId[docId] = path
    docIdByKitablePath[path] = docId
    tablesByKitablePath[path] = (doc.tables || []).map((t: any) => ({
      id: Number(t.id),
      ...(String(t.name ?? '').trim() ? { name: String(t.name).trim() } : {}),
      title: String(t.title ?? ''),
      order: Number(t.order ?? 0),
      primaryFieldId: t.primary_field_id != null ? Number(t.primary_field_id) : null,
    }))
    dashboardsByKitablePath[path] = readDataDashboards(doc.meta).map((dashboard) => ({
      id: dashboard.id,
      title: dashboard.title,
      order: dashboard.order,
    }))
  }
  const workflowsByKitablePath: Record<string, KitableWorkflowSummary[]> = {}
  for (const workflow of workflows) {
    const docId = String(
      workflow.trigger?.documentId
      || workflow.action?.addRecord?.targetDocumentId
      || '',
    ).trim()
    const kitablePath = kitablePathByDocId[docId]
    if (!kitablePath) continue
    if (!workflowsByKitablePath[kitablePath]) workflowsByKitablePath[kitablePath] = []
    workflowsByKitablePath[kitablePath].push({
      id: String(workflow.id),
      name: String(workflow.name || 'Untitled workflow'),
      enabled: Boolean(workflow.enabled),
    })
  }
  for (const workflow of formWorkflows) {
    const kitablePath = kitablePathByDocId[String(workflow.target.document_id)]
    if (!kitablePath) continue
    if (!workflowsByKitablePath[kitablePath]) workflowsByKitablePath[kitablePath] = []
    workflowsByKitablePath[kitablePath].push({
      id: workflow.id,
      name: workflow.name || 'Untitled form',
      enabled: workflow.published && workflow.schedule.enabled,
      kind: 'form_sync',
    })
  }
  return { tablesByKitablePath, dashboardsByKitablePath, workflowsByKitablePath, docIdByKitablePath }
}

function rekey<T>(map: Record<string, T>, fromPath: string, toPath: string): Record<string, T> {
  if (!(fromPath in map)) return map
  const { [fromPath]: moved, ...rest } = map
  return { ...rest, [toPath]: moved }
}

/**
 * Index of table, dashboard, and workflow leaves per .kitable file, read
 * through the query cache so the sidebar, leaf actions, and WorkspaceScreen
 * share one request and refresh together when a workflow or .kitable file
 * changes (see src/api/invalidation.ts).
 */
export function useKitableChildrenIndex(rootPath?: string): KitableChildrenIndex {
  const queryClient = useQueryClient()
  const rootKey = workspaceRootKey(rootPath)
  const queryKey = useMemo(() => queryKeys.kitableIndex(rootKey), [rootKey])
  const query = useQuery({
    queryKey,
    queryFn: () => loadKitableChildrenSnapshot(rootPath),
  })

  const snapshot = query.data ?? EMPTY_SNAPSHOT
  const status: KitableChildrenIndex['status'] = query.isError
    ? 'error'
    : query.isSuccess && !query.isFetching
      ? 'done'
      : query.isFetching || query.isPending
        ? 'loading'
        : 'idle'
  const error = query.error ? (query.error instanceof Error ? query.error.message : 'Failed to load kitable children') : null

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey })
    await queryClient.refetchQueries({ queryKey })
  }, [queryClient, queryKey])

  const updateSnapshot = useCallback((update: (current: KitableChildrenSnapshot) => KitableChildrenSnapshot) => {
    queryClient.setQueryData<KitableChildrenSnapshot>(queryKey, (current) => update(current ?? EMPTY_SNAPSHOT))
  }, [queryClient, queryKey])

  const renameKitablePath = useCallback((fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) return
    updateSnapshot((current) => ({
      tablesByKitablePath: rekey(current.tablesByKitablePath, fromPath, toPath),
      dashboardsByKitablePath: rekey(current.dashboardsByKitablePath, fromPath, toPath),
      workflowsByKitablePath: rekey(current.workflowsByKitablePath, fromPath, toPath),
      docIdByKitablePath: rekey(current.docIdByKitablePath, fromPath, toPath),
    }))
  }, [updateSnapshot])

  // Sub-table title edits only call updateDataTable on the backend; patch the
  // cached title so the sidebar does not show the stale one until a refetch.
  useEffect(() => {
    function handleTableRename(event: Event) {
      const detail = (event as CustomEvent).detail as {
        vaultPath?: string
        tableId?: number
        newName?: string
      } | undefined
      const vaultPath = detail?.vaultPath
      const tableId = detail?.tableId
      const newName = detail?.newName
      if (!vaultPath || typeof tableId !== 'number' || typeof newName !== 'string') return
      updateSnapshot((current) => {
        const existing = current.tablesByKitablePath[vaultPath]
        if (!existing) return current
        let changed = false
        const next = existing.map((table) => {
          if (table.id !== tableId || table.title === newName) return table
          changed = true
          return { ...table, title: newName }
        })
        if (!changed) return current
        return { ...current, tablesByKitablePath: { ...current.tablesByKitablePath, [vaultPath]: next } }
      })
    }
    window.addEventListener('kition:data-document:table:rename', handleTableRename)
    return () => window.removeEventListener('kition:data-document:table:rename', handleTableRename)
  }, [updateSnapshot])

  return useMemo(() => ({
    status,
    tablesByKitablePath: snapshot.tablesByKitablePath,
    dashboardsByKitablePath: snapshot.dashboardsByKitablePath,
    workflowsByKitablePath: snapshot.workflowsByKitablePath,
    docIdByKitablePath: snapshot.docIdByKitablePath,
    error,
    refresh,
    renameKitablePath,
  }), [status, snapshot, error, refresh, renameKitablePath])
}
