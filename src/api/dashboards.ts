import {
  deleteDataDashboard,
  listDataDashboards,
  openDataDocumentByPath,
  putDataDashboard,
} from '@/api/dataDocuments'
import { createStarterDataDashboard } from '@/features/dashboard/lib/dashboardCreation'
import type { DataDashboard, DataDocument } from '@/types/dataDocument'

export async function createDataDashboardByPath(
  path: string,
  sourceTableId?: number,
): Promise<{ dashboard: DataDashboard; document: DataDocument }> {
  const document = await openDataDocumentByPath({ path })
  const tables = [...(document.tables || [])].sort((left, right) => left.order - right.order)
  const sourceTable = sourceTableId == null
    ? tables[0]
    : tables.find((table) => table.id === sourceTableId) || tables[0]
  if (!sourceTable) {
    throw new Error('Create a table before adding a dashboard.')
  }
  const existing = await listDataDashboards(document.id)
  const dashboard = createStarterDataDashboard(sourceTable, existing.items || [])
  const created = await putDataDashboard(document.id, dashboard)
  return { dashboard: created, document }
}

export async function openDataDashboardByPath(
  path: string,
  dashboardId: string,
): Promise<{ dashboard: DataDashboard; document: DataDocument }> {
  const document = await openDataDocumentByPath({ path })
  const listed = await listDataDashboards(document.id)
  const dashboard = (listed.items || []).find((item) => item.id === dashboardId)
  if (!dashboard) {
    throw new Error('Dashboard not found')
  }
  return { dashboard, document }
}

export async function updateDataDashboard(
  document: DataDocument,
  dashboard: DataDashboard,
): Promise<{ dashboard: DataDashboard; document: DataDocument }> {
  const updated = await putDataDashboard(document.id, dashboard)
  return { dashboard: updated, document }
}

export async function renameDataDashboardByPath(
  path: string,
  dashboardId: string,
  title: string,
) {
  const opened = await openDataDashboardByPath(path, dashboardId)
  return updateDataDashboard(opened.document, {
    ...opened.dashboard,
    title,
  })
}

export async function deleteDataDashboardByPath(path: string, dashboardId: string) {
  const document = await openDataDocumentByPath({ path })
  return deleteDataDashboard(document.id, dashboardId)
}
