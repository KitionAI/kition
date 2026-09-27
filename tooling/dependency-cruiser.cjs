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
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Import cycle. Move the shared piece into a leaf module (src/lib or <feature>/lib) that neither side re-imports.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-feature-internals',
      severity: 'error',
      comment: 'Import another feature only through src/features/<name>/public.ts.',
      from: { path: '^src/features/([^/]+)/' },
      to: {
        path: '^src/features/([^/]+)/',
        pathNot: ['^src/features/$1/', '^src/features/[^/]+/public\\.ts$'],
      },
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
