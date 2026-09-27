import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export default defineConfig({
  root: repositoryDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(repositoryDir, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: true,
    testTimeout: 10_000,
    minWorkers: 1,
    maxWorkers: 4,
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx', 'electron/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['e2e/**', 'playwright-report/**', 'test-results/**'],
    // Coverage floors for the areas that hold user data and editor state.
    // Values are the measurement from 2026-09-27 rounded down; raise them as
    // tests land, never lower them. `pnpm run test:coverage` enforces them.
    coverage: {
      provider: 'v8',
      include: ['src/features/table/**', 'src/features/document/hooks/**', 'src/services/**'],
      exclude: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.d.ts'],
      reporter: ['text-summary'],
      thresholds: {
        'src/features/table/**': { statements: 28, branches: 23, functions: 29, lines: 28 },
        'src/features/document/hooks/**': { statements: 34, branches: 29, functions: 43, lines: 34 },
        'src/services/**': { statements: 64, branches: 58, functions: 68, lines: 66 },
      },
    },
  },
})
