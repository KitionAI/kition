import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * Hooks the renderer-side desktop bridge with an in-memory proxy state that
 * lets the test inspect and drive the four proxy IPC methods without spinning
 * up Electron. Stores last save/test payloads on window so assertions can
 * reach in for them.
 *
 * The default state matches `createDefaultDesktopProxyConfig`: disabled, http,
 * blank host/port, no stored password.
 */
async function mockDesktopBridge(
  page: Page,
  options: {
    initialState?: Record<string, unknown>
    saveRequiresRestart?: boolean
    testResult?: { ok: boolean; latencyMs?: number; message?: string }
    restartResult?: { ok: boolean; message?: string }
  } = {},
) {
  const initialState = options.initialState ?? {
    enabled: false,
    scheme: 'http',
    host: '',
    port: 0,
    username: '',
    noProxy: 'localhost, 127.0.0.1, ::1',
    hasPassword: false,
  }
  const saveRequiresRestart = options.saveRequiresRestart ?? false
  const testResult = options.testResult ?? { ok: true, latencyMs: 42 }
  const restartResult = options.restartResult ?? { ok: true }

  await page.addInitScript(
    ([initial, requiresRestart, testRes, restartRes]) => {
      const stateWindow = window as typeof window & Record<string, any>
      let current = { ...(initial as Record<string, unknown>) }
      stateWindow.__proxyCalls = {
        get: 0,
        save: [] as unknown[],
        test: [] as unknown[],
        restart: 0,
      }
      stateWindow.kitionDesktop = {
        shell: 'electron',
        DesktopInfo: async () => ({
          is_desktop: true,
          platform: 'darwin',
          backend_base_url: 'http://127.0.0.1:18101/api',
          data_dir: '/tmp/kition/data',
          cache_dir: '/tmp/kition/cache',
          logs_dir: '/tmp/kition/logs',
          uploads_dir: '/tmp/kition/uploads',
          exports_dir: '/tmp/kition/exports',
          supports_secure_storage: true,
        }),
        BootstrapInitialize: async () => ({
          installation_id: 'desktop-test-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'desktop-test-installation',
            diagnostics: {
              code: '', title: '', message: '', detail: '', support_id: '',
              retryable: false, next_action: '',
            },
          },
        }),
        StoreSecureValue: async () => {},
        ReadSecureValue: async () => '',
        ProxyGet: async () => {
          stateWindow.__proxyCalls.get += 1
          return current
        },
        ProxySave: async (payload: Record<string, unknown>) => {
          stateWindow.__proxyCalls.save.push(payload)
          const { password, ...rest } = payload
          // Mirror the main process's "three-way password" semantics so the
          // hasPassword flag flips correctly between save round-trips.
          let hasPassword = Boolean(current.hasPassword)
          if (password === '') hasPassword = false
          else if (typeof password === 'string' && password.length > 0) hasPassword = true
          current = { ...rest, hasPassword }
          return { state: current, requiresRestart: Boolean(requiresRestart) }
        },
        ProxyTest: async (payload?: Record<string, unknown>) => {
          stateWindow.__proxyCalls.test.push(payload)
          return testRes
        },
        ProxyRestartBackend: async () => {
          stateWindow.__proxyCalls.restart += 1
          return restartRes
        },
      }
    },
    [initialState, saveRequiresRestart, testResult, restartResult] as const,
  )
}

test.beforeEach(async ({ page }) => {
  await mockLocalWorkspaceApi(page)
})

/**
 * Waits for NetworkSettings to finish its initial getProxyState() round-trip.
 * The pane renders a placeholder (no .settings-row entries) until the IPC
 * mock resolves, so every test that interacts with form rows must wait first.
 *
 * `Use proxy` is rendered via i18n in the `settings` namespace; we use it as a
 * sentinel both because it is the first row and because seeing it confirms i18n
 * resources have hydrated.
 */
async function waitForNetworkPanel(page: Page) {
  await expect(
    page.locator('.settings-row').filter({ hasText: 'Use proxy' }),
  ).toBeVisible()
}

function useProxyRow(page: Page) {
  return page.locator('.settings-row').filter({ hasText: 'Use proxy' })
}

test('network panel: defaults render disabled with Test button greyed out', async ({ page }) => {
  await mockDesktopBridge(page)

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)

  // Section heading from settings.json sections.network.title
  await expect(page.getByRole('button', { name: 'Network' })).toBeVisible()

  await expect(useProxyRow(page).getByRole('switch')).toHaveAttribute('aria-checked', 'false')

  // Test button is disabled until proxy is enabled + has valid host/port.
  await expect(page.getByRole('button', { name: 'Test', exact: true })).toBeDisabled()
})

test('network panel: enable + fill + Test posts the live form to ProxyTest', async ({ page }) => {
  await mockDesktopBridge(page, { testResult: { ok: true, latencyMs: 17 } })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)

  // Toggle on
  await useProxyRow(page).locator('.el-switch').click()

  // Fill host + port (default scheme 'http' is fine)
  await page.getByPlaceholder('proxy.company.com').fill('proxy.example.com')
  await page.getByPlaceholder('1080').fill('8080')

  // Test
  await page.getByRole('button', { name: 'Test', exact: true }).click()

  // Latency feedback uses the i18n template with the ms value
  await expect(page.getByText(/Latency 17 ms/)).toBeVisible()

  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.test.length).toBe(1)
  expect(calls.test[0]).toMatchObject({
    enabled: true,
    scheme: 'http',
    host: 'proxy.example.com',
    port: 8080,
  })
  // We sent the live form, not a stored copy
  expect(calls.save.length).toBe(0)
})

test('network panel: Test surfaces failure message verbatim', async ({ page }) => {
  await mockDesktopBridge(page, {
    testResult: { ok: false, message: 'connect timeout (5s) — proxy.example.com:9999' },
  })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()
  await page.getByPlaceholder('proxy.company.com').fill('proxy.example.com')
  await page.getByPlaceholder('1080').fill('9999')
  await page.getByRole('button', { name: 'Test', exact: true }).click()

  await expect(page.getByText(/connect timeout/)).toBeVisible()
})

test('network panel: Save without requiresRestart shows Saved and no restart dialog', async ({ page }) => {
  await mockDesktopBridge(page, { saveRequiresRestart: false })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()
  await page.getByPlaceholder('proxy.company.com').fill('proxy.example.com')
  await page.getByPlaceholder('1080').fill('8080')

  // The action bar's Save button appears only when there are unsaved changes.
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByText('Saved', { exact: true })).toBeVisible()
  // No restart dialog
  await expect(page.getByRole('dialog', { name: /Restart background service/i })).toHaveCount(0)

  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.save.length).toBe(1)
  expect(calls.restart).toBe(0)
})

test('network panel: Save with requiresRestart prompts and calls ProxyRestartBackend on confirm', async ({ page }) => {
  await mockDesktopBridge(page, { saveRequiresRestart: true })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()
  await page.getByPlaceholder('proxy.company.com').fill('proxy.example.com')
  await page.getByPlaceholder('1080').fill('1080')

  await page.getByRole('button', { name: 'Save', exact: true }).click()

  // Restart confirm dialog appears.
  const dialog = page.getByRole('dialog', { name: /Restart background service/i })
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Save and restart' }).click()

  await expect(page.getByText('Background service restarted.')).toBeVisible()
  await expect(dialog).toBeHidden()

  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.restart).toBe(1)
})

test('network panel: Cancel on restart dialog leaves backend untouched', async ({ page }) => {
  await mockDesktopBridge(page, { saveRequiresRestart: true })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()
  await page.getByPlaceholder('proxy.company.com').fill('proxy.example.com')
  await page.getByPlaceholder('1080').fill('1080')

  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: /Restart background service/i })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

  await expect(dialog).toBeHidden()
  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.restart).toBe(0)
})

test('network panel: validation blocks Save when host is empty after enabling', async ({ page }) => {
  await mockDesktopBridge(page)

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()
  // Leave host blank; port too.

  // The action bar only shows Save when dirty AND validation passes (per
  // NetworkSettings's `dirty && !hasErrors` guard). Confirm Save isn't there.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  // Test button also stays disabled while errors are present.
  await expect(page.getByRole('button', { name: 'Test', exact: true })).toBeDisabled()
})

test('network panel: stored password shows placeholder and Clear flips to password=""', async ({ page }) => {
  await mockDesktopBridge(page, {
    initialState: {
      enabled: true,
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
      username: 'alice',
      noProxy: 'localhost',
      hasPassword: true,
    },
  })

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)

  const passwordInput = page.locator('input[type="password"]')
  await expect(passwordInput).toBeVisible()
  await expect(passwordInput).toHaveAttribute('placeholder', '••••••••')

  // Clear stored password affordance.
  await page.getByRole('button', { name: 'Clear stored password' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.save.length).toBe(1)
  expect(calls.save[0]).toMatchObject({ password: '' })
})

test('network panel: switching scheme to SOCKS5 propagates to Save payload', async ({ page }) => {
  await mockDesktopBridge(page)

  await page.goto('/settings?section=network')
  await waitForNetworkPanel(page)
  await useProxyRow(page).locator('.el-switch').click()

  // The Scheme picker is the custom Select widget from components/ui — a button
  // that toggles a menu of role=option entries. The native <select> it wraps is
  // sr-only and not driveable via selectOption() in Playwright.
  await page
    .locator('.settings-row')
    .filter({ hasText: 'Scheme' })
    .getByRole('button', { name: 'Scheme' })
    .click()
  await page.getByRole('option', { name: 'SOCKS5', exact: true }).click()
  await page.getByPlaceholder('proxy.company.com').fill('socks.example.com')
  await page.getByPlaceholder('1080').fill('1080')

  await page.getByRole('button', { name: 'Save', exact: true }).click()

  const calls = await page.evaluate(() => (window as any).__proxyCalls)
  expect(calls.save[0]).toMatchObject({ scheme: 'socks5', host: 'socks.example.com', port: 1080 })
})
