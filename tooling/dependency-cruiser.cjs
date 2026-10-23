/**
 * Module boundary rules for the client.
 *
 * Features under src/features/<name> may depend on shared layers
 * (src/components, src/api, src/services, src/lib, src/types, src/i18n,
 * src/styles), on the packages under packages/ through their entries, and on
 * other features only through that feature's public entry
 * (src/features/<other>/public.ts). Packages import nothing from src/. Import
 * cycles are forbidden everywhere. Known violations live in tooling/dependency-cruiser.known.json
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
      name: 'packages-import-nothing-from-the-app',
      severity: 'error',
      comment:
        'A package under packages/ runs outside Kition too (the board editor in the Board kit, the document editor in the Document kit), so it imports nothing from src/ but the KDM copy (as @kition/kdm). The board editor uses app services through BoardHost (packages/board-editor/src/host.tsx), implemented in src/features/whiteboard/host. The document editor uses them through DocumentHost (packages/document-editor/src/host.ts), implemented in src/features/document/host.',
      from: { path: '^packages/' },
      // src/lib/kdm and src/lib/kit-engine are kition-sdk's @kition/kdm and @kition/kit-engine,
      // which Kition carries (scripts/sync-kit-host.mjs); packages import them by those names, which
      // a kit's build takes from kition-sdk.
      to: { path: '^src/', pathNot: '^src/lib/(kdm|kit-engine)/' },
    },
    {
      name: 'app-ui-is-a-leaf-package',
      severity: 'error',
      comment: 'packages/app-ui holds the shared UI primitives; it depends on npm packages only.',
      from: { path: '^packages/app-ui/' },
      to: { path: '^packages/(?!app-ui/)' },
    },
    {
      name: 'app-uses-board-editor-entries',
      severity: 'error',
      comment:
        'Import the board through its entries: @kition/board-editor (agent types, host seam, record and element types), @kition/board-editor/model (the board on the KDM), or @kition/board-editor/editor (the editor). Export what the app needs from packages/board-editor/src/{index,model,editor}.ts.',
      from: { path: '^src/' },
      to: { path: '^packages/board-editor/src/', pathNot: '^packages/board-editor/src/(index|model|editor)\\.ts$' },
    },
    {
      name: 'app-uses-document-editor-entries',
      severity: 'error',
      comment:
        'Import the Markdown document through its entries: @kition/document-editor (host seam, agent action types, image import, parsers), /model (the document on the KDM), /file (a Markdown file as a replica, without the editor), /editor (the editor), /commands, /clipboard, /markdown, or /mermaid. Export what the app needs from packages/document-editor/src/{index,model,file,editor,commands,clipboard,markdown,mermaid}.ts.',
      from: { path: '^src/' },
      to: { path: '^packages/document-editor/src/', pathNot: '^packages/document-editor/src/(index|model|file|editor|commands|clipboard|markdown|mermaid)\\.ts$' },
    },
    {
      name: 'shared-layers-do-not-import-features',
      severity: 'error',
      comment: 'src/components, src/lib, src/services, src/api, and src/types must stay feature-agnostic.',
      from: { path: '^src/(components|lib|services|api|types)/' },
      to: { path: '^src/features/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // A kit's web/ app (packages/document-kit/web) is built by its own toolchain from Kition's styles and strings.
    exclude: { path: ['\\.spec\\.(ts|tsx)$', '^packages/[^/]+/web/'] },
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
