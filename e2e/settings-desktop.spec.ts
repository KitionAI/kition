import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

async function mockDesktopBridge(page: Page) {
  await page.addInitScript(() => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const secureStore = new Map<string, string>()

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
            code: '',
            title: '',
            message: '',
            detail: '',
            support_id: '',
            retryable: false,
            next_action: '',
          },
        },
      }),
      StoreSecureValue: async (key: string, value: string) => {
        const writer = stateWindow.__desktopWriteSecureValue as undefined | ((storageKey: string, storageValue: string) => Promise<void> | void)
        if (writer) {
          await writer(key, value)
          return
        }
        secureStore.set(key, value)
      },
      ReadSecureValue: async (key: string) => {
        const reader = stateWindow.__desktopReadSecureValue as undefined | ((storageKey: string) => Promise<string> | string)
        if (reader) {
          return await reader(key)
        }
        return secureStore.get(key) || ''
      },
      OpenRuntimePath: async (kind: string) => {
        const recorder = stateWindow.__desktopOpenRuntimePath as undefined | ((path: string) => Promise<void> | void)
          || stateWindow.__recordRuntimePath as undefined | ((path: string) => Promise<void> | void)
        if (recorder) {
          await recorder(kind)
        }
      },
    }
  })
}

async function selectOpenAIProvider(page: Page) {
  await page.getByRole('button', { name: /OpenAI/ }).click()
  await expect(page.getByLabel('API key')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await mockLocalWorkspaceApi(page, {
    discoverModelsByProvider: {
      openai: ['gpt-5.4', 'gpt-5.4-mini'],
    },
  })
})

test('desktop settings manage providers and synced models', async ({ page }) => {
  await mockDesktopBridge(page)

  await page.goto('/settings?section=models')

  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI Providers' })).toBeVisible()
  await expect(page.getByText('Default model', { exact: true })).toHaveCount(0)

  await selectOpenAIProvider(page)
  await page.getByLabel('API key').fill('desktop-test-key')

  await page.getByRole('button', { name: 'Save provider', exact: true }).click()

  await page.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect(page.locator('.settings-provider-metadata')).toContainText('2')
})

test('removed writing editor route returns to the workspace', async ({ page }) => {
  const secureStore = new Map<string, string>()
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=models')
  await selectOpenAIProvider(page)
  await page.getByLabel('API key').fill('desktop-test-key')
  await page.getByRole('button', { name: 'Sync now', exact: true }).click()
  await expect(page.locator('.settings-provider-metadata')).toContainText('2')

  await page.goto('/writing/wechat_article')
  await expect(page).toHaveURL(/\/documents$/)
  await expect(page.getByTestId('document-tree')).toBeVisible()
})

test('removed image page route returns to the workspace', async ({ page }) => {
  const secureStore = new Map<string, string>()
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/image')
  await expect(page).toHaveURL(/\/documents$/)
  await expect(page.getByTestId('document-tree')).toBeVisible()
})

test('desktop settings expose runtime directory actions', async ({ page }) => {
  const openedRuntimePaths: string[] = []
  await page.exposeFunction('__desktopOpenRuntimePath', async (kind: string) => {
    openedRuntimePaths.push(kind)
  })
  await mockDesktopBridge(page)

  await page.goto('/settings?section=runtime')

  await expect(page.getByRole('button', { name: 'Data' })).toBeVisible()
  const dataRuntimeCard = page.locator('.settings-row').filter({ hasText: 'Local data directory' })
  await expect(dataRuntimeCard).toBeVisible()
  await dataRuntimeCard.getByRole('button', { name: 'Open' }).click()

  await expect.poll(() => openedRuntimePaths.slice()).toEqual(['data'])
})

test('desktop settings persist general preferences after save and reload', async ({ page }) => {
  const secureStore = new Map<string, string>()
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=general')

  const restoreWorkspaceSwitch = page
    .locator('.settings-row')
    .filter({ hasText: 'Restore workspace on launch' })
    .locator('.el-switch')

  await expect(restoreWorkspaceSwitch.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await restoreWorkspaceSwitch.click()
  await expect(restoreWorkspaceSwitch.getByRole('switch')).toHaveAttribute('aria-checked', 'false')

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('settings-action-bar-saved')).toBeVisible()

  await page.reload()

  const reloadedRestoreWorkspaceSwitch = page
    .locator('.settings-row')
    .filter({ hasText: 'Restore workspace on launch' })
    .locator('.el-switch')

  await expect(reloadedRestoreWorkspaceSwitch.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})

test('desktop settings persist a dark theme after reload', async ({ page }) => {
  const secureStore = new Map<string, string>([
    ['kition.desktop.settings.v1', JSON.stringify({ general: { theme: 'light' } })],
  ])
  await page.addInitScript(() => {
    localStorage.setItem('kition.desktop.theme.darkDefaultMigration.v1', 'done')
  })
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=display')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()

  const saveButton = page.getByRole('button', { name: 'Save', exact: true })
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
  await expect(page.getByTestId('settings-action-bar-saved')).toBeVisible()
  await expect.poll(() => secureStore.get('kition.desktop.settings.v1') || '').toContain('"theme":"dark"')

  await page.reload()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme-mode', 'dark')
})

test('desktop settings apply dark theme across the document workspace', async ({ page }) => {
  const secureStore = new Map<string, string>([
    ['kition.desktop.settings.v1', JSON.stringify({ general: { theme: 'light' } })],
  ])
  await page.addInitScript(() => {
    localStorage.setItem('kition.desktop.theme.darkDefaultMigration.v1', 'done')
  })
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=display')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme-mode', 'dark')

  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page).toHaveURL(/\/documents$/)
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByTestId('document-editor')).toBeVisible()
})

test('settings action bar stays above scrolling display controls', async ({ page }) => {
  const secureStore = new Map<string, string>()
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=display')
  await page.getByRole('button', { name: 'Dark', exact: true }).click()

  const content = page.locator('.settings-modal-content')
  const actionBar = page.locator('.settings-action-bar')
  const lineHeightRow = page.locator('.settings-row').filter({ hasText: 'Agent timeline line height' })
  const normalButton = lineHeightRow.getByRole('button', { name: 'Normal', exact: true })

  await expect(actionBar).toBeVisible()
  await normalButton.scrollIntoViewIfNeeded()

  const barBox = await actionBar.boundingBox()
  const buttonBox = await normalButton.boundingBox()
  expect(barBox).not.toBeNull()
  expect(buttonBox).not.toBeNull()

  const targetY = barBox!.y + barBox!.height / 2
  await content.evaluate((element, delta) => {
    element.scrollTop += delta
  }, buttonBox!.y + buttonBox!.height / 2 - targetY)

  const probe = await actionBar.evaluate((element) => {
    const styles = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const contentRect = element.closest('.settings-modal-content')?.getBoundingClientRect()
    const topElement = document.elementFromPoint(rect.right - 24, rect.top + rect.height / 2)
    return {
      backgroundColor: styles.backgroundColor,
      bottomGap: contentRect ? Math.round(contentRect.bottom - rect.bottom) : Number.POSITIVE_INFINITY,
      pointerEvents: styles.pointerEvents,
      topmost: Boolean(topElement?.closest('.settings-action-bar')),
      zIndex: Number(styles.zIndex),
    }
  })

  expect(probe.zIndex).toBeGreaterThan(0)
  expect(probe.bottomGap).toBeLessThanOrEqual(1)
  expect(probe.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  expect(probe.pointerEvents).not.toBe('none')
  expect(probe.topmost).toBe(true)
})

test('desktop settings keep a live light-theme preview after syncing provider models', async ({ page }) => {
  const secureStore = new Map<string, string>([
    ['kition.desktop.settings.v1', JSON.stringify({ general: { theme: 'dark' } })],
  ])
  await page.addInitScript(() => {
    localStorage.setItem('kition.desktop.theme.darkDefaultMigration.v1', 'done')
  })
  await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
    secureStore.set(key, value)
  })
  await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
  await mockDesktopBridge(page)

  await page.goto('/settings?section=display')
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByRole('button', { name: 'Light' }).click()

  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme-mode', 'light')

  await page.getByRole('button', { name: 'AI Providers' }).click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme', 'light')
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme-mode', 'light')
  await expect(page).toHaveURL(/section=models/)
  await selectOpenAIProvider(page)
  await page.getByLabel('API key').fill('desktop-test-key')
  await page.getByRole('button', { name: 'Sync now', exact: true }).click()

  await expect.poll(() => secureStore.get('kition.desktop.settings.v1') || '').toContain('"theme":"dark"')
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await expect(page.locator('html')).toHaveAttribute('data-desktop-theme', 'light')
})

test('closing a directly opened settings route returns to the workspace', async ({ page }) => {
  await mockDesktopBridge(page)

  await page.goto('/settings?section=general')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page).toHaveURL(/\/documents$/)
  await expect(page.getByTestId('document-tree')).toBeVisible()
})
