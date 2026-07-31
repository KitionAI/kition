import { openDataDocumentByPath, updateDataDocument } from '@/api/dataDocuments'
import {
  readDataDashboards,
  replaceDataDashboard,
  writeDataDashboards,
} from '@/features/dashboard/lib/dashboardMetadata'
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
  const dashboard = createStarterDataDashboard(sourceTable, readDataDashboards(document.meta))
  return updateDataDashboard(document, dashboard)
}

export async function openDataDashboardByPath(
  path: string,
  dashboardId: string,
): Promise<{ dashboard: DataDashboard; document: DataDocument }> {
  const document = await openDataDocumentByPath({ path })
  const dashboard = readDataDashboards(document.meta).find((item) => item.id === dashboardId)
  if (!dashboard) {
    throw new Error('Dashboard not found')
  }
  return { dashboard, document }
}

export async function updateDataDashboard(
  document: DataDocument,
  dashboard: DataDashboard,
): Promise<{ dashboard: DataDashboard; document: DataDocument }> {
  const updatedDocument = await updateDataDocument(document.id, {
    meta: replaceDataDashboard(document.meta, dashboard),
  })
  const updatedDashboard = readDataDashboards(updatedDocument.meta)
    .find((item) => item.id === dashboard.id) || dashboard
  return { dashboard: updatedDashboard, document: updatedDocument }
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
  const dashboards = readDataDashboards(document.meta)
    .filter((dashboard) => dashboard.id !== dashboardId)
  return updateDataDocument(document.id, {
    meta: writeDataDashboards(document.meta, dashboards),
  })
}
