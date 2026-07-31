import type {
  DataDashboard,
  DataDashboardSeed,
  DataDocument,
} from '@/types/dataDocument'

export const DATA_DASHBOARDS_META_KEY = 'dashboards'

export function readDataDashboards(
  meta?: Record<string, unknown> | null,
): DataDashboard[] {
  const dashboards = meta?.[DATA_DASHBOARDS_META_KEY]
  if (!Array.isArray(dashboards)) return []

  return dashboards.filter(isDataDashboard)
}

export function writeDataDashboards(
  meta: Record<string, unknown> | null | undefined,
  dashboards: DataDashboard[],
): Record<string, unknown> {
  return {
    ...(meta || {}),
    [DATA_DASHBOARDS_META_KEY]: dashboards,
  }
}

export function replaceDataDashboard(
  meta: Record<string, unknown> | null | undefined,
  dashboard: DataDashboard,
): Record<string, unknown> {
  const current = readDataDashboards(meta)
  const existingIndex = current.findIndex((item) => item.id === dashboard.id)
  const dashboards = existingIndex >= 0
    ? current.map((item) => item.id === dashboard.id ? dashboard : item)
    : [...current, dashboard]
  return writeDataDashboards(meta, dashboards)
}

export function materializeDashboardSeeds(
  document: DataDocument,
  seeds: DataDashboardSeed[],
): DataDashboard[] {
  return seeds.map((seed) => {
    const table = document.tables?.find((item) => (
      item.name === seed.source_table_name || item.title === seed.source_table_name
    ))
    if (!table) {
      throw new Error(`Dashboard source table was not created: ${seed.source_table_name}`)
    }
    const { source_table_name: _sourceTableName, ...dashboard } = seed
    return {
      ...dashboard,
      source_table_id: table.id,
    }
  })
}

function isDataDashboard(value: unknown): value is DataDashboard {
  if (!value || typeof value !== 'object') return false
  const dashboard = value as Partial<DataDashboard>
  return typeof dashboard.id === 'string'
    && typeof dashboard.title === 'string'
    && typeof dashboard.order === 'number'
    && typeof dashboard.source_table_id === 'number'
    && Array.isArray(dashboard.layout)
    && Array.isArray(dashboard.widgets)
}
