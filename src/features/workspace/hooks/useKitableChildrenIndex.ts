import { useCallback, useEffect, useState } from 'react'

import { listDataDocuments } from '@/api/dataDocuments'
import { readDataDashboards } from '@/features/dashboard/lib/dashboardMetadata'
import { listWorkflows } from '@/features/workflow/api'
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
  // Rekeys the in-memory maps when a .kitable file is renamed/moved on disk.
  // The next full refresh will pick up the new path from the backend, but the
  // tree depends on this lookup *synchronously* to render virtual children —
  // without the rekey, the kitable's table/workflow leaves vanish until the
  // backend list call returns.
  renameKitablePath: (fromPath: string, toPath: string) => void
}

export function useKitableChildrenIndex(rootPath?: string): KitableChildrenIndex {
  const [status, setStatus] = useState<KitableChildrenIndex['status']>('idle')
  const [tablesByKitablePath, setTables] = useState<Record<string, KitableTableSummary[]>>({})
  const [dashboardsByKitablePath, setDashboards] = useState<Record<string, KitableDashboardSummary[]>>({})
  const [workflowsByKitablePath, setWorkflows] = useState<Record<string, KitableWorkflowSummary[]>>({})
  const [docIdByKitablePath, setDocIds] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (isWebPreviewMode()) {
      setTables({})
      setDashboards({})
      setWorkflows({})
      setDocIds({})
      setError(null)
      setStatus('done')
      return
    }
    setStatus('loading')
    setError(null)
    try {
      const workflowsPromise = (async () => {
        try {
          return await listWorkflows()
        } catch {
          return []
        }
      })()
      const [docs, workflows] = await Promise.all([
        listDataDocuments(rootPath ? { workspace_root: rootPath } : undefined),
        workflowsPromise,
      ])
      const nextTables: Record<string, KitableTableSummary[]> = {}
      const nextDashboards: Record<string, KitableDashboardSummary[]> = {}
      const kitablePathByDocId: Record<string, string> = {}
      const nextDocIds: Record<string, string> = {}
      for (const doc of docs.items || []) {
        const path = String(doc.path || '').trim()
        if (!path.toLowerCase().endsWith('.kitable')) continue
        const docId = String(doc.id)
        kitablePathByDocId[docId] = path
        nextDocIds[path] = docId
        nextTables[path] = (doc.tables || []).map((t: any) => ({
          id: Number(t.id),
          ...(String(t.name ?? '').trim() ? { name: String(t.name).trim() } : {}),
          title: String(t.title ?? ''),
          order: Number(t.order ?? 0),
          primaryFieldId: t.primary_field_id != null ? Number(t.primary_field_id) : null,
        }))
        nextDashboards[path] = readDataDashboards(doc.meta).map((dashboard) => ({
          id: dashboard.id,
          title: dashboard.title,
          order: dashboard.order,
        }))
      }
      const nextWorkflows: Record<string, KitableWorkflowSummary[]> = {}
      for (const workflow of workflows) {
        const docId = String(
          workflow.trigger?.documentId
          || workflow.action?.addRecord?.targetDocumentId
          || '',
        ).trim()
        const kitablePath = kitablePathByDocId[docId]
        if (!kitablePath) continue
        if (!nextWorkflows[kitablePath]) nextWorkflows[kitablePath] = []
        nextWorkflows[kitablePath].push({
          id: String(workflow.id),
          name: String(workflow.name || 'Untitled workflow'),
          enabled: Boolean(workflow.enabled),
        })
      }
      setTables(nextTables)
      setDashboards(nextDashboards)
      setWorkflows(nextWorkflows)
      setDocIds(nextDocIds)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Failed to load kitable children')
    }
  }, [rootPath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const renameKitablePath = useCallback((fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) {
      return
    }
    setTables((current) => {
      if (!(fromPath in current)) return current
      const { [fromPath]: moved, ...rest } = current
      return { ...rest, [toPath]: moved }
    })
    setDashboards((current) => {
      if (!(fromPath in current)) return current
      const { [fromPath]: moved, ...rest } = current
      return { ...rest, [toPath]: moved }
    })
    setWorkflows((current) => {
      if (!(fromPath in current)) return current
      const { [fromPath]: moved, ...rest } = current
      return { ...rest, [toPath]: moved }
    })
    setDocIds((current) => {
      if (!(fromPath in current)) return current
      const { [fromPath]: moved, ...rest } = current
      return { ...rest, [toPath]: moved }
    })
  }, [])

  // Sub-table title edits update only updateDataTable on the backend; without
  // this listener the sidebar tree would show the stale title until the next
  // full refresh of the kitable children index.
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
      setTables((current) => {
        const existing = current[vaultPath]
        if (!existing) return current
        let changed = false
        const next = existing.map((table) => {
          if (table.id !== tableId || table.title === newName) return table
          changed = true
          return { ...table, title: newName }
        })
        if (!changed) return current
        return { ...current, [vaultPath]: next }
      })
    }
    window.addEventListener('kition:data-document:table:rename', handleTableRename)
    return () => window.removeEventListener('kition:data-document:table:rename', handleTableRename)
  }, [])

  return {
    status,
    tablesByKitablePath,
    dashboardsByKitablePath,
    workflowsByKitablePath,
    docIdByKitablePath,
    error,
    refresh,
    renameKitablePath,
  }
}
