/**
 * Module boundary rules for the client.
 *
 * Features under src/features/<name> may depend on shared layers
 * (src/components, src/api, src/services, src/lib, src/types, src/i18n,
 * src/registry, src/styles) and on other features only through that feature's
 * public entry (src/features/<other>/public.ts). Import cycles are forbidden
 * everywhere. Known violations live in tooling/dependency-cruiser.known.json
 * and are checked with --ignore-known so the count can only go down.
 */
/**
 * The Kition side of src/features/table and src/features/dashboard: the TableDataSource and
 * TableHost implementations (host/), and what Kition builds around the editor (opening it in
 * a tab, workspace creation from templates, file import into a new table, co-editing). Every
 * other file there is the editor, which reaches its data and app services only through
 * src/features/table/ports, so that it can run on another data source and host.
 */
const TABLE_HOST_SIDE = [
  '^src/features/table/host/',
  '^src/features/table/public\\.ts$',
  '^src/features/table/templates/',
  '^src/features/table/components/(TableEditorPane|KitableTemplateLibraryDialog)\\.tsx$',
  '^src/features/table/lib/(tableCreation|openTables|importWorkspaceFileIntoDataTable|importCsvIntoDataTable|tableFileImport|templateAssets)\\.ts$',
  '^src/features/dashboard/components/DashboardEditorPane\\.tsx$',
]

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Import cycle. Move the shared piece into a leaf module (src/lib or <feature>/lib) that neither side re-imports.',
      from: { pathNot: '^src/lib/sdk/' },
      to: { circular: true },
    },
    {
      // src/lib/sdk is copied verbatim from kition-sdk (scripts/sync-kit-host.mjs), where one of
      // its modules imports a type from the module that imports it. Runtime cycles still fail.
      name: 'no-circular-copied-sdk',
      severity: 'error',
      comment: 'Import cycle in the object model copy. Fix it in kition-sdk packages/sdk and sync again.',
      from: { path: '^src/lib/sdk/' },
      to: { circular: true, viaOnly: { dependencyTypesNot: ['type-only'] } },
    },
    {
      name: 'no-feature-internals',
      severity: 'error',
      comment: 'Import another feature only through src/features/<name>/public.ts.',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/',
        // The dashboard editor ships with the table editor and shares its data seam.
        pathNot: ['^src/features/$1/', '^src/features/[^/]+/public\\.ts$', '^src/features/table/ports/'],
      },
    },
    {
      name: 'kit-sdk-core-is-portable',
      comment:
        'src/features/kits/sdk is the portable core of the open Kit SDK (docs/kit-sdk.md): it may use npm packages and itself, never the rest of Kition.',
      severity: 'error',
      from: { path: '^src/features/kits/sdk/' },
      to: { path: '^src/', pathNot: '^src/features/kits/sdk/' },
    },
    {
      name: 'table-editor-uses-data-source-and-host',
      severity: 'error',
      comment:
        'The table editor reads and writes table data through useTableDataSource() and uses app services through useTableHost() (src/features/table/ports). Add what it needs to TableDataSource or TableHost, implement it in src/features/table/host, and keep runtime requests, services, and other features out of the editor.',
      from: { path: '^src/features/(table|dashboard)/', pathNot: TABLE_HOST_SIDE },
      to: {
        path: [
          '^src/api/(?!generated/|dataImports\\.ts$)',
          '^src/services/',
          '^src/lib/(notify|bundledAssets|openDocuments)',
          '^src/features/(?!table/|dashboard/)',
          ...TABLE_HOST_SIDE,
        ],
      },
    },
    {
      name: 'table-editor-imports-only-types-from-data-imports',
      severity: 'error',
      comment: 'The table editor runs file imports through useTableHost().fileImport; it may only use the src/api/dataImports types.',
      from: { path: '^src/features/(table|dashboard)/', pathNot: TABLE_HOST_SIDE },
      to: { path: '^src/api/dataImports\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'shared-layers-do-not-import-features',
      severity: 'error',
      comment: 'src/components, src/lib, src/services, src/api, and src/types must stay feature-agnostic.',
      from: { path: '^src/(components|lib|services|api|types|registry)/' },
      to: { path: '^src/features/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.(ts|tsx)$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
