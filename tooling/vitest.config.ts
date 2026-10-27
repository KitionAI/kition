import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root: repositoryDir,
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(repositoryDir, 'src') },
      // The packages under packages/ are imported by path alias, not installed (packages/README.md).
      // kition-sdk's @kition/kdm, which Kition carries as src/lib/kdm (scripts/sync-kit-host.mjs).
      { find: /^@kition\/kdm$/, replacement: resolve(repositoryDir, 'src/lib/kdm/index.ts') },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    testTimeout: 10_000,
    minWorkers: 1,
    maxWorkers: 4,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'packages/*/src/**/*.spec.ts', 'packages/*/src/**/*.spec.tsx', 'src-tauri/scripts/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['e2e/**', 'playwright-report/**', 'test-results/**'],
    // Coverage floors for the areas that hold user data and editor state.
    // Values are the measurement from 2026-09-27 rounded down; raise them as
    // tests land, never lower them. `pnpm run test:coverage` enforces them.
    coverage: {
      provider: 'v8',
      include: ['src/services/**'],
      exclude: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.d.ts'],
      reporter: ['text-summary'],
      thresholds: {
        'src/services/**': { statements: 64, branches: 58, functions: 68, lines: 66 },
      },
    },
  },
})
