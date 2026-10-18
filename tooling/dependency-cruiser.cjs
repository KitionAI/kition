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
        pathNot: ['^src/features/$1/', '^src/features/[^/]+/public\\.ts$'],
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
