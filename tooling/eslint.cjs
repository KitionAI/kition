/* Self-contained lint configuration for the public Kition client. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  plugins: ['@typescript-eslint', 'react-hooks', 'jsx-a11y', 'sonarjs'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    // Beta-pragmatic — let real warnings surface, don't fail on common idioms.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-empty-object-type': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Plugins registered so that pre-existing eslint-disable comments resolve;
    // rules themselves stay off to avoid introducing new findings before beta.
    'react-hooks/exhaustive-deps': 'off',
    'jsx-a11y/click-events-have-key-events': 'off',
    'jsx-a11y/no-noninteractive-tabindex': 'off',
    'jsx-a11y/no-static-element-interactions': 'off',
    'sonarjs/cognitive-complexity': 'off',
    // Beta-pragmatic: demote pre-existing eslint:recommended findings from
    // error to warn. Signal stays visible without blocking the gate.
    'no-useless-escape': 'warn',
    'no-mixed-spaces-and-tabs': 'warn',
    'no-irregular-whitespace': 'warn',
    'no-misleading-character-class': 'warn',
    'no-control-regex': 'warn',
    'no-constant-condition': 'warn',
    'prefer-const': 'warn',
    '@typescript-eslint/no-unused-expressions': 'warn',
    '@typescript-eslint/no-this-alias': 'warn',
    // File and function size ceilings. Files that already exceed them are
    // listed in the size-baseline override below; that list may only shrink.
    'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true, IIFEs: false }],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'sonner',
            message: 'Import from @/lib/notify instead. Direct sonner usage is only allowed inside src/lib/notify/ and Shell.tsx (for <Toaster>).',
          },
          {
            name: 'radix-ui',
            message: 'Use the primitives in @kition/app-ui (packages/app-ui) instead of importing Radix directly in features.',
          },
        ],
        patterns: [
          {
            group: ['@radix-ui/*'],
            message: 'Use the primitives in @kition/app-ui (packages/app-ui) instead of importing Radix directly in features.',
          },
        ],
      },
    ],

    'no-restricted-syntax': [
      'warn',
      {
        selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
        message: 'Do not hardcode hex colors. Use the semantic tokens documented in the CSS Variable Mapping.',
      },
      {
        selector: 'Literal[value=/(?:bg|text|border|fill|stroke|ring|shadow|outline|divide|placeholder|caret|accent|from|via|to)-\\[#[0-9a-fA-F]{3,8}/]',
        message: 'Do not hardcode hex colors in Tailwind arbitrary values. Use semantic token classes.',
      },
    ],
  },
  ignorePatterns: [
    'dist/',
    'dist-desktop/',
    'node_modules/',
    // shadcn-ui upstream, not our style domain
    'packages/app-ui/src/button.tsx',
    'packages/app-ui/src/command.tsx',
    'packages/app-ui/src/dialog.tsx',
    'packages/app-ui/src/input.tsx',
    'packages/app-ui/src/popover.tsx',
    'packages/app-ui/src/spinner.tsx',
    'packages/app-ui/src/switch.tsx',
    'packages/app-ui/src/tooltip.tsx',
    'packages/app-ui/src/hooks/use-*.ts',
    'public/',
    'src-tauri/target/',
    'src-tauri/gen/',
    '*.config.{js,cjs,mjs,ts}',
  ],
  overrides: [
    {
      files: ['**/*.tsx'],
      rules: { 'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }] },
    },
    {
      // Size baseline (files already over the max-lines ceiling on 2026-09-27). Only remove entries; never add.
      files: [
        'src/app/Shell.tsx',
        'src/features/agent/hooks/useWorkspaceAgent.ts',
        'src/features/agent/lib/agentTimeline.ts',
        'src/features/document/components/DocumentMarkdownEditorPane.tsx',
        'src/features/document/editor/editor/DocumentCommandPalette.tsx',
        'packages/document-editor/src/editor/commands.ts',
        'packages/document-editor/src/editor/extensions/live-preview.ts',
        'packages/document-editor/src/editor/extensions/table-widget.ts',
        'packages/board-editor/src/components/WhiteboardCanvas.tsx',
        'packages/board-editor/src/lib/whiteboardAgentPatch.ts',
        'src/features/workflow/pages/WorkflowHomePage.tsx',
        'src/features/workspace/components/WorkspaceEditorContent.tsx',
        'src/features/workspace/components/WorkspaceScreen.tsx',
        'src/features/workspace/components/WorkspaceTree.tsx',
        'src/services/desktop.ts',
      ],
      rules: { 'max-lines': 'off' },
    },
    {
      // Size baseline (files with a function over 200 lines on 2026-09-27). Only remove entries; never add.
      files: [
        'src/app/Shell.tsx',
        'src/features/agent/components/AgentAiComposer.tsx',
        'src/features/agent/components/AgentChatPanel.tsx',
        'src/features/agent/components/AgentModelPicker.tsx',
        'src/features/agent/hooks/useWorkspaceAgent.ts',
        'src/features/design/components/DesignCanvas.tsx',
        'src/features/design/components/DesignEditorPane.tsx',
        'src/features/design/components/DesignInspector.tsx',
        'src/features/document/components/DocumentMarkdownEditorPane.tsx',
        'src/features/document/editor/editor/DocumentTagBrowserDialog.tsx',
        'packages/document-editor/src/editor/extensions/live-preview.ts',
        'packages/document-editor/src/editor/extensions/table-widget.ts',
        'src/features/document/hooks/useWorkspaceDocumentAutosave.ts',
        'src/features/document/hooks/useWorkspaceDocumentSession.ts',
        'src/features/document/lib/documentTemplates.ts',
        'src/features/document/lib/extendedDocumentTemplates.ts',
        'src/features/emailProviders/EmailProvidersPane.tsx',
        'src/features/emailSync/EmailSyncSettingsPanel.tsx',
        'src/features/emailSync/EmailSyncWorkflowPage.tsx',
        'src/features/formSync/FormSyncWorkflowPage.tsx',
        'src/features/settings/AiModelsPane.tsx',
        'src/features/settings/NetworkSettings.tsx',
        'packages/board-editor/src/components/WhiteboardCanvas.tsx',
        'src/features/whiteboard/components/WhiteboardEditorPane.tsx',
        'src/features/media-generation/components/ImageStudio.tsx',
        'packages/board-editor/src/components/WhiteboardSelectionOverlay.tsx',
        'packages/board-editor/src/components/WhiteboardSelectionToolbar.tsx',
        'packages/board-editor/src/components/WhiteboardTopActions.tsx',
        'packages/board-editor/src/hooks/useWhiteboardEditor.ts',
        'packages/board-editor/src/hooks/useWhiteboardElementActions.ts',
        'packages/board-editor/src/hooks/useWhiteboardInteractionMachine.ts',
        'packages/board-editor/src/hooks/useWhiteboardMindMapActions.ts',
        'packages/board-editor/src/lib/whiteboardAgentPatch.ts',
        'src/features/workflow/canvas/NodeCard.tsx',
        'src/features/workflow/canvas/WorkflowCanvas.tsx',
        'src/features/workflow/pages/WorkflowHomePage.tsx',
        'src/features/workflow/pages/WorkflowIndexPage.tsx',
        'src/features/workflow/templates/builtins.ts',
        'src/features/workspace/components/WorkspaceAgentTabBar.tsx',
        'src/features/workspace/components/WorkspaceEditorContent.tsx',
        'src/features/workspace/components/WorkspaceLauncherScreen.tsx',
        'src/features/workspace/components/WorkspaceScreen.tsx',
        'src/features/workspace/components/WorkspaceSidebar.tsx',
        'src/features/workspace/components/WorkspaceTabStrip.tsx',
        'src/features/workspace/components/WorkspaceTree.tsx',
        'src/features/workspace/components/WorkspaceWorkflowCreateModeDialog.tsx',
        'src/features/workspace/hooks/useWorkspaceTabs.ts',
        'src/features/workspace/hooks/useWorkspaceTreeCreateActions.ts',
        'src/features/workspace/hooks/useWorkspaceTreeNodeActions.ts',
      ],
      rules: { 'max-lines-per-function': 'off' },
    },
    {
      files: ['**/*.spec.ts', '**/*.spec.tsx', 'e2e/**', 'scripts/**', 'tooling/**'],
      rules: { 'max-lines': 'off', 'max-lines-per-function': 'off' },
    },
    {
      // KitFiles' host side, copied from kition-sdk by scripts/sync-kit-host.mjs: its shape is decided there.
      files: ['src/features/kits/host/files.ts'],
      rules: { 'max-lines-per-function': 'off' },
    },
    {
      // Object-model typings generated from each kit's schema (scripts/generate-kit.mjs in kition-sdk).
      files: ['src/lib/sdk/kits/**'],
      rules: { 'max-lines': 'off' },
    },
    {
      files: ['src/lib/notify/**', 'src/app/Shell.tsx'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      // The kit itself wraps Radix; features consume the wrappers.
      files: ['src/components/**', 'packages/app-ui/src/**'],
      rules: { 'no-restricted-imports': ['error', { paths: [{ name: 'sonner', message: 'Import from @/lib/notify instead.' }] }] },
    },
    {

      files: [
        'src/features/document/lib/pdfExportHtml.ts',
        'packages/document-editor/src/editor/extensions/live-preview.ts',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.test.ts',
        '**/*.test.tsx',
        'e2e/**',
        'scripts/**',
        'src-tauri/scripts/**',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
}
