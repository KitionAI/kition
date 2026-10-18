/**
 * Public entry of the table editor package: its data and host seams (`TableDataSource`,
 * `TableHost`), the table document types, and the helpers a host shares with the editor. The
 * editors themselves load from their own entries (`@kition/table-editor/TableEditor`,
 * `/DashboardEditor`, `/TableFileImportDialog`), so importing this one stays light.
 */
export * from './types/base'
export * from './types/dataDocument'
export * from './types/aiConfig'
export * from './types/tableFilter'
export * from './types/dataImports'
export * from './lib/timestamps'
export * from './table/ports/TableDataSource'
export * from './table/ports/TableHost'
export * from './table/lib/csvImport'
export * from './table/lib/tableActions'
export * from './dashboard/lib/dashboardCreation'
export * from './dashboard/lib/dashboardMetadata'
