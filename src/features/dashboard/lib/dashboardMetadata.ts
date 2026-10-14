import type {
  DataDashboard,
  DataDashboardSeed,
  DataDocument,
} from '@/types/dataDocument'

/** Seeds (template dashboards, naming their source table by name) into dashboards ready for
 * `putDataDashboard` (`@/api/dataDocuments`), once `document`'s tables exist to resolve
 * `source_table_name` against. */
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
