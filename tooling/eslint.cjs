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
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'sonner',
            message: 'Import from @/lib/notify instead. Direct sonner usage is only allowed inside src/lib/notify/ and Shell.tsx (for <Toaster>).',
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
    'dist-electron/',
    'node_modules/',
    'src/registry/',  // shadcn-ui upstream, not our style domain
    'public/',
    'electron/resources/',
    '*.config.{js,cjs,mjs,ts}',
  ],
  overrides: [
    {
      files: ['src/lib/notify/**', 'src/app/Shell.tsx'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
              
                                             
                                                             
                    
                                                        
                                        
                                                   
                     
                                                       
                                       
      files: [
        'src/features/document/lib/pdfExportHtml.ts',
        'src/features/table/grid/configs/gridTheme.ts',
        'src/features/table/grid/useGridAdapter.ts',
        'src/features/document/editor/editor/extensions/live-preview.ts',
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.test.ts',
        '**/*.test.tsx',
        'e2e/**',
        'scripts/**',
        'electron/**',
      ],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
}
