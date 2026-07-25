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
  },
})
