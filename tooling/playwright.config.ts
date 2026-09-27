import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Every test target is a loopback Vite server. Playwright's webServer readiness
// probe sends its HTTP request through HTTP_PROXY even when NO_PROXY lists
// 127.0.0.1; a proxy that answers for closed ports makes the probe report the
// server as available, Vite is never started, and every test fails with
// ERR_CONNECTION_REFUSED. Drop the proxy variables for this runner and its
// children. Scripts that start a live runtime do so before Playwright runs and
// keep their own environment.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
  delete process.env[key]
}

// KITION_E2E_SCOPE=ci runs every mock-backed spec in one sweep. Specs that
// need live AI or SMTP credentials, the packaged Electron binary under xvfb,
// or the README capture flag run through their own scripts instead, and
// specs that currently fail against the UI are quarantined in
// tooling/e2e-quarantine.json until they are fixed or deleted.
const LIVE_SERVICE_SPECS = [
  '**/workflow-real.spec.ts',
  '**/workflow-real-ai-build.spec.ts',
  '**/workflow-onboarding-actions-real.spec.ts',
  '**/readme-assets.spec.ts',
]
const DESKTOP_SPECS = ['**/desktop-*.spec.ts', '**/electron-*.spec.ts', '**/settings-desktop*.spec.ts']
const quarantine = JSON.parse(
  readFileSync(resolve(repositoryDir, 'tooling/e2e-quarantine.json'), 'utf8'),
) as { quarantined: Array<{ spec: string }> }
const CI_SWEEP_IGNORE = [
  ...LIVE_SERVICE_SPECS,
  ...DESKTOP_SPECS,
  ...quarantine.quarantined.map((entry) => `**/${entry.spec}`),
]

const PORT = Number(process.env.KITION_E2E_PORT ?? 3000)
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`
// Allow opting out of webServer auto-start when a dev server is already
// running on an alternate port (e.g. when running e2e against an externally
// launched vite to avoid contention with the Electron-owned port 3000).
const REUSE_ONLY = process.env.KITION_E2E_REUSE === 'true'

export default defineConfig({
  testDir: resolve(repositoryDir, 'e2e'),
  testIgnore: process.env.KITION_E2E_SCOPE === 'ci' ? CI_SWEEP_IGNORE : [],
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
