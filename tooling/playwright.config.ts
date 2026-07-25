import { defineConfig, devices } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PORT = Number(process.env.KITION_E2E_PORT ?? 3000)
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`
// Allow opting out of webServer auto-start when a dev server is already
// running on an alternate port (e.g. when running e2e against an externally
// launched vite to avoid contention with the Electron-owned port 3000).
const REUSE_ONLY = process.env.KITION_E2E_REUSE === 'true'

export default defineConfig({
  testDir: resolve(repositoryDir, 'e2e'),
  outputDir: resolve(repositoryDir, 'test-results'),
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  ...(REUSE_ONLY
    ? {}
    : {
        webServer: {
          command: `pnpm exec vite --config tooling/vite.config.ts --host 127.0.0.1 --port ${PORT}`,
          cwd: repositoryDir,
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
})
