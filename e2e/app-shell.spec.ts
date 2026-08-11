import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { getWorkspaceStorageKey } from '../src/features/onboarding/workspaceStorageKey'

const APP_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const SYSTEM_THEME_VAULT_PATH = '/tmp/kition-system-theme-vault'
const SYSTEM_THEME_DOC_PATH = 'complex-document-template.md'

async function mockDesktopAccountBridge(page: Page) {
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
      DeleteSecureValue: async (key: string) => {
        const deleter = stateWindow.__desktopDeleteSecureValue as undefined | ((storageKey: string) => Promise<void> | void)
        if (deleter) {
          await deleter(key)
          return
        }
        secureStore.delete(key)
      },
      OpenExternalURL: async (url: string) => {
        const recorder = stateWindow.__desktopOpenExternalURL as undefined | ((targetURL: string) => Promise<void> | void)
        if (recorder) {
          await recorder(url)
        }
      },
    }
  })
}

async function mockSupportDiagnosticsBridge(page: Page) {
  await page.addInitScript(() => {
    const stateWindow = window as typeof window & Record<string, unknown>
    const secureStore = new Map<string, string>()

    stateWindow.kitionDesktop = {
      shell: 'electron',
      DesktopInfo: async () => ({
        is_desktop: true,
        platform: 'darwin',
        app_version: '0.1.0',
        backend_base_url: 'http://127.0.0.1:18101/api',
        data_dir: '/Users/member/private/data',
        cache_dir: '/Users/member/private/cache',
        logs_dir: '/Users/member/private/logs',
        uploads_dir: '/Users/member/private/uploads',
        exports_dir: '/Users/member/private/exports',
        workspace_dir: '/Users/member/Secret Workspace',
        supports_secure_storage: true,
      }),
      BackendStatus: async () => ({
        base_url: 'http://127.0.0.1:18101',
        health_url: 'http://127.0.0.1:18101/health',
        running: true,
        last_error: 'token=secret-value',
        logs: 'private prompt and document contents',
        log_file: '/Users/member/private/kition.log',
        launch_mode: 'managed',
        binary_path: '/Users/member/private/runtime',
        config_path: '/Users/member/private/config.json',
        working_dir: '/Users/member/Secret Workspace',
        command: 'run --api-key secret-value',
        protocol_version: 3,
      }),
      BootstrapStatus: async () => ({
        official_build: true,
        build_channel: 'rc',
        available: true,
        state: 'ready',
        installation_id: 'private-installation-id',
        diagnostics: {
          code: 'startup_ready',
          title: 'Member member@example.com',
          message: 'Document: /Users/member/Secret Workspace/private.md',
          detail: 'api_key=secret-value',
          support_id: 'SUPPORT-1234',
          retryable: false,
          next_action: 'none',
        },
      }),
      StoreSecureValue: async (key: string, value: string) => {
        secureStore.set(key, value)
      },
      ReadSecureValue: async (key: string) => secureStore.get(key) || '',
      DeleteSecureValue: async (key: string) => {
        secureStore.delete(key)
      },
      OpenExternalURL: async () => {},
    }

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          stateWindow.__copiedSupportDiagnostics = value
        },
      },
    })
  })
}

async function mockDesktopWorkspaceBridge(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const content = [
        '# Complex document title',
        '',
        'Type: knowledge page',
        'Status: draft',
        'Tags: #knowledge-base #longform',
        '',
        '## Background',
        '',
        'Start by describing the problem this document addresses, its scope, and the key constraints.',
        '',
        '## Structure',
        '',
        '1. Goals',
        '2. Decisions',
        '3. Tasks',
        '',
        '## Risks',
        '',
        'Spell out unresolved assumptions and the follow-up validation steps.',
      ].join('\n')
      const docs = new Map<string, { content: string; updated_at: string }>([
        [docPath, { content, updated_at: '2026-06-07T00:00:00.000Z' }],
      ])
      const vault = {
        path: vaultPath,
        name: 'System Theme Vault',
        added_at: '2026-06-07T00:00:00.000Z',
        last_opened_at: '2026-06-07T00:00:00.000Z',
      }
      const makeRegistry = () => ({ vaults: [vault], active_vault_path: vaultPath })
      const makeListResponse = () => ({
        root_path: vaultPath,
        items: Array.from(docs.entries()).map(([path, record]) => ({
          type: 'file' as const,
          path,
          name: path.split('/').pop() || path,
          format: 'markdown' as const,
          size: record.content.length,
          updated_at: record.updated_at,
        })),
      })

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
          workspace_dir: vaultPath,
          supports_secure_storage: true,
        }),
        BootstrapInitialize: async () => ({
          installation_id: 'system-theme-test-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'system-theme-test-installation',
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
          secureStore.set(key, value)
        },
        ReadSecureValue: async (key: string) => secureStore.get(key) || '',
        DeleteSecureValue: async (key: string) => {
          secureStore.delete(key)
        },
        OpenExternalURL: async () => {},
        OpenRuntimePath: async () => {},
        ListVaults: async () => makeRegistry(),
        AddVault: async () => ({ vault, registry: makeRegistry() }),
        RemoveVault: async () => makeRegistry(),
        RenameVault: async () => ({ vault, registry: makeRegistry() }),
        SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),
        ChooseDirectory: async () => ({ canceled: true, path: '' }),
        ListWorkspaceDocuments: async () => makeListResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) {
            throw new Error(`document not found: ${req.path}`)
          }
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: record.content,
            format: 'markdown',
            updated_at: record.updated_at,
            size: record.content.length,
          }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: req.content,
            format: 'markdown',
            updated_at,
            size: req.content.length,
          }
        },
      }
    },
    { vaultPath: SYSTEM_THEME_VAULT_PATH, docPath: SYSTEM_THEME_DOC_PATH },
  )

  await page.addInitScript(({ docPath }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', docPath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  }, { docPath: SYSTEM_THEME_DOC_PATH })
}

test.describe('app shell navigation', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
  })

  test('navigates across the remaining main workspace routes from the shell', async ({ page }) => {
    await page.goto('/')

    await expect(page).toHaveURL(/\/documents$/)
    await expect(page.getByTestId('document-tree')).toBeVisible()
    await expect(page.getByTestId('document-editor')).toBeVisible()

    await expect(page.getByRole('link', { name: 'Writing' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Images' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Videos' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Creation history' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Accounts & publishing' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Layout templates' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Logs' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Help docs' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveCount(0)

    const treeBox = await page.getByTestId('document-tree').boundingBox()
    const editorBox = await page.getByTestId('document-editor').boundingBox()
    expect(treeBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(treeBox!.x).toBeLessThan(20)
    expect(editorBox!.x - treeBox!.x - treeBox!.width).toBeLessThan(8)

    const settingsButton = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(settingsButton).toBeVisible()
    const settingsBox = await settingsButton.boundingBox()
    expect(settingsBox).not.toBeNull()
    expect(settingsBox!.x).toBeLessThan(80)

    await page.getByTestId('document-editor').evaluate((element) => {
      element.setAttribute('data-preserve-probe', 'alive')
    })
    await settingsButton.click()
    await expect(page).toHaveURL(/\/documents$/)
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await expect(page.getByTestId('document-editor')).toHaveAttribute('data-preserve-probe', 'alive')
    await expect(page.getByRole('button', { name: 'General' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Shortcuts', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hooks', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Notifications', exact: true })).toHaveCount(0)
    await expect(page.getByText('Enable notifications', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await expect(page.getByTestId('portal-profile-page')).toBeVisible()
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Network', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Data', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Developer', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Shortcuts', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hooks', exact: true })).toHaveCount(0)
    await expect(page.locator('.settings-nav-button.is-active')).toHaveCount(1)
    await page.getByRole('button', { name: 'AI Providers' }).click()
    await expect(page.getByRole('searchbox', { name: 'Search AI providers' })).toBeVisible()
    await page.getByRole('button', { name: 'Email Providers' }).click()
    await expect(page.getByTestId('email-providers-pane')).toBeVisible()
    await expect(page.getByText('Adjust theme, language, and update strategy in one place')).toHaveCount(0)
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await expect(page).toHaveURL(/\/documents$/)
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await expect(page.getByTestId('document-editor')).toHaveAttribute('data-preserve-probe', 'alive')
    await expect(page.getByRole('button', { name: 'Open AI Chat' })).toBeEnabled()
    await settingsButton.click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
  })

  test('restores the sidebar from the empty workspace home', async ({ page }) => {
    await page.goto('/documents')
    await expect(page.getByTestId('document-editor')).toBeVisible()

    const closeTabButtons = page.locator('.document-tab-list .document-tab-close')
    await expect(closeTabButtons).toHaveCount(1)
    await closeTabButtons.click()
    await expect(page.locator('.document-tab-list .document-tab')).toHaveCount(0)

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', 'true')

    const expandButton = page.getByTestId('workspace-sidebar-expand')
    await expect(expandButton).toBeVisible()
    await expect(expandButton).toHaveAttribute('data-window-drag-exclude', 'true')
    await expandButton.click()

    await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', 'false')
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  })

  test('loads command and search palettes on first use', async ({ page }) => {
    await mockDesktopWorkspaceBridge(page)
    await page.goto('/documents', { waitUntil: 'networkidle' })
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled()

    await page.keyboard.press('Control+K')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    await page.keyboard.press('Control+Shift+F')
    await expect(page.getByTestId('search-palette')).toBeVisible()
    await expect(page.getByTestId('search-palette-input')).toBeVisible()
  })

  test('keeps backendless web preview free of optional startup errors', async ({ page }) => {
    let notificationPolicyCalls = 0
    let lifecycleHookCalls = 0

    await page.route('**/api/v1/desktop/notifications', async (route) => {
      notificationPolicyCalls += 1
      await route.fulfill({ status: 502, body: '' })
    })
    await page.route('**/api/v1/desktop/hooks/lifecycle', async (route) => {
      lifecycleHookCalls += 1
      await route.fulfill({ status: 502, body: '' })
    })
    await page.route('**/api/v1/agent/sessions', async (route) => {
      await route.fulfill({ status: 502, body: '' })
    })

    await page.goto('/documents')
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await page.waitForTimeout(250)

    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0)
    expect(notificationPolicyCalls).toBe(0)
    expect(lifecycleHookCalls).toBe(0)
  })

  test('preserves legacy settings deep links inside the new navigation hierarchy', async ({ page }) => {
    for (const [section, expected] of [
      ['providers', 'AI Providers'],
      ['demos', 'General'],
      ['advanced', 'Developer'],
      ['runtime', 'Data'],
      ['account', 'Account'],
      ['shortcuts', 'General'],
      ['mcp', 'General'],
      ['hooks', 'General'],
      ['notifications', 'General'],
    ] as const) {
      await page.goto(`/settings?section=${section}`)
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await expect(page.locator('.settings-nav-button.is-active')).toHaveText(expected)
      if (section === 'runtime' || section === 'advanced') {
        await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toHaveAttribute('aria-expanded', 'true')
      }
    }
  })

  test('keeps Account and Advanced settings usable at a narrow viewport', async ({ page }) => {
    await page.goto('/documents')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.setViewportSize({ width: 420, height: 720 })

    const dialog = page.getByRole('dialog', { name: 'Settings' })
    const dialogBox = await dialog.boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
    expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(420)
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(720)

    await page.getByRole('button', { name: 'Account', exact: true }).click()
    await expect(page.getByTestId('portal-profile-page')).toBeVisible()
    await expect(page.locator('.settings-nav-button.is-active')).toHaveCount(1)
    expect(await page.locator('.settings-modal-content').evaluate((element) => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true)

    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Network', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Data', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Developer', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Shortcuts', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'MCP', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hooks', exact: true })).toHaveCount(0)
    await expect(page.locator('.settings-nav-button.is-active')).toHaveCount(1)

    await page.getByRole('button', { name: 'Developer', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Developer' })).toBeVisible()
    await expect(page.locator('.settings-nav-button.is-active')).toHaveCount(1)
    expect(await page.locator('.settings-modal-window').evaluate((element) => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true)
  })

  test('copies redacted support diagnostics from About settings', async ({ page }) => {
    await mockSupportDiagnosticsBridge(page)
    await page.goto('/documents')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'About' }).click()
    await page.getByTestId('copy-support-diagnostics').click()

    await expect(page.getByTestId('support-diagnostics-feedback')).toContainText('Redacted diagnostics copied')
    const diagnostics = await page.evaluate(() => (
      (window as typeof window & Record<string, unknown>).__copiedSupportDiagnostics as string
    ))

    expect(diagnostics).toContain('schema: kition-support-diagnostics/v1')
    expect(diagnostics).toContain('runtime.protocol: 3')
    expect(diagnostics).toContain('runtime.state: ready')
    expect(diagnostics).toContain('account.state: signed_out')
    expect(diagnostics).toContain('update.state:')
    expect(diagnostics).toContain('support.id: SUPPORT-1234')
    for (const sensitive of [
      '/Users/member',
      'Secret Workspace',
      'member@example.com',
      'secret-value',
      'private.md',
      'private prompt and document contents',
      'private-installation-id',
      'http://',
      'https://',
    ]) {
      expect(diagnostics).not.toContain(sensitive)
    }
  })

  test('keeps anonymous product analytics off until enabled and clears it when disabled', async ({ page }) => {
    await page.goto('/documents')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const analyticsToggle = page.getByTestId('share-usage-data-toggle')
    await expect(analyticsToggle).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByText('Analytics event inspector')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('kition.analytics.installation.v1'))).toBeNull()

    await page.setViewportSize({ width: 420, height: 720 })
    const settingsBox = await page.getByRole('dialog', { name: 'Settings' }).boundingBox()
    expect(settingsBox).not.toBeNull()
    expect(settingsBox!.x).toBeGreaterThanOrEqual(0)
    expect(settingsBox!.x + settingsBox!.width).toBeLessThanOrEqual(420)
    expect(await page.locator('.settings-modal-window').evaluate((element) => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true)
    await page.setViewportSize({ width: 1280, height: 720 })

    await analyticsToggle.click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(analyticsToggle).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: 'Developer', exact: true }).click()
    await expect(page.getByText('Analytics event inspector')).toBeVisible()
    await expect(page.getByText(/events waiting on this device/)).not.toContainText('0 events')
    await page.setViewportSize({ width: 420, height: 720 })
    await page.getByRole('button', { name: 'Recent events' }).click()
    await page.locator('[data-testid="analytics-event-inspector"] summary').first().click()
    await expect(page.locator('[data-testid="analytics-event-inspector"] pre').first()).toContainText('kition-product-event/v1')
    expect(await page.locator('.settings-modal-window').evaluate((element) => (
      element.scrollWidth <= element.clientWidth + 1
    ))).toBe(true)
    await page.setViewportSize({ width: 1280, height: 720 })

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByTestId('reopen-getting-started').click()
    await expect(page.getByTestId('first-run-activation')).toBeVisible()
    await page.getByTestId('first-run-start-local').click()
    await expect(page.getByTestId('first-run-activation')).toHaveCount(0)

    const enabledState = await page.evaluate(() => ({
      installationId: localStorage.getItem('kition.analytics.installation.v1'),
      queue: JSON.parse(localStorage.getItem('kition.analytics.queue.v1') || '[]') as Array<Record<string, unknown>>,
    }))
    expect(enabledState.installationId).toMatch(/^anon_/)
    expect(enabledState.queue).toContainEqual(expect.objectContaining({
      name: 'app_started',
      app_version: APP_VERSION,
      build_identity: 'dev',
      platform: 'web',
    }))
    expect(enabledState.queue.some((event) => event.name === 'onboarding_started')).toBe(true)
    expect(enabledState.queue).toContainEqual(expect.objectContaining({
      name: 'provider_choice_selected',
      provider_choice: 'local',
    }))
    expect(enabledState.queue).toContainEqual(expect.objectContaining({
      name: 'onboarding_completed',
      provider_choice: 'local',
      result: 'success',
    }))
    for (const event of enabledState.queue) {
      expect(Object.keys(event).sort()).toEqual(expect.arrayContaining([
        'app_version',
        'build_identity',
        'id',
        'installation_id',
        'name',
        'occurred_at',
        'platform',
        'schema',
      ]))
      const serialized = JSON.stringify(event)
      expect(serialized).not.toContain('/tmp/')
      expect(serialized).not.toContain('complex-document-template.md')
      expect(serialized).not.toContain('prompt')
      expect(serialized).not.toContain('token')
      expect(serialized).not.toContain('http://')
      expect(serialized).not.toContain('https://')
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    await analyticsToggle.click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(analyticsToggle).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('button', { name: 'Advanced', exact: true }).click()
    await page.getByRole('button', { name: 'Developer', exact: true }).click()
    await expect(page.getByText('0 events waiting on this device.')).toBeVisible()
    const disabledState = await page.evaluate(() => ({
      installationId: localStorage.getItem('kition.analytics.installation.v1'),
      queue: localStorage.getItem('kition.analytics.queue.v1'),
      once: localStorage.getItem('kition.analytics.once.v1'),
    }))
    expect(disabledState).toEqual({ installationId: null, queue: null, once: null })
  })

  test('keeps shell buttons clickable after closing settings modal', async ({ page }) => {
    await page.goto('/documents')
    await expect(page.getByTestId('document-editor')).toBeVisible()

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.getByRole('button', { name: 'Close settings', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Open AI Chat' }).click()
    await page.getByRole('button', { name: 'New chat' }).click()
    await expect(page.getByRole('tab', { name: 'New chat', selected: true })).toBeVisible()
    await expect(page.getByPlaceholder('Plan, write, or ask anything…')).toBeVisible()
  })

  test('keeps document workspace flush at narrow desktop widths', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 760 })
    await page.goto('/documents')
    await expect(page.getByTestId('document-tree')).toBeVisible()
    await expect(page.getByTestId('document-editor')).toBeVisible()

    const treeBox = await page.getByTestId('document-tree').boundingBox()
    const editorBox = await page.getByTestId('document-editor').boundingBox()
    expect(treeBox).not.toBeNull()
    expect(editorBox).not.toBeNull()
    expect(treeBox!.x).toBeLessThan(20)
    expect(editorBox!.x - treeBox!.x - treeBox!.width).toBeLessThan(8)
  })

  test('marks macOS desktop chrome surfaces as draggable without breaking controls', async ({ page }) => {
    await mockDesktopWorkspaceBridge(page)
    await page.goto('/documents')
    await expect(page.locator('.app-topbar')).toBeVisible()
    await expect(page.locator('.workspace-sidebar-header')).toBeVisible()
    await expect(page.locator('.document-tab').first()).toBeVisible()

    const appRegionReport = await page.evaluate(() => {
      const readRegion = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector)
        if (!element) {
          return null
        }
        return getComputedStyle(element).getPropertyValue('-webkit-app-region').trim()
      }

      return {
        topbar: readRegion('.app-topbar'),
        sidebarHeader: readRegion('.workspace-sidebar-header'),
        documentTab: readRegion('.document-tab'),
        sidebarTabButton: readRegion('.workspace-sidebar-header [role="tab"]'),
        sidebarHeaderAction: readRegion('.workspace-sidebar-header-action'),
      }
    })

    expect(appRegionReport).toEqual({
      topbar: 'drag',
      sidebarHeader: 'drag',
      documentTab: 'no-drag',
      sidebarTabButton: 'no-drag',
      sidebarHeaderAction: 'no-drag',
    })
  })

  test('keeps default dark document editor surfaces and completion results readable', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await mockDesktopWorkspaceBridge(page)
    await page.goto('/documents')

    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page.locator('html')).toHaveAttribute('data-desktop-theme-mode', 'dark')
    await expect(page.getByTestId('document-editor')).toBeVisible()
    await page.locator([
      '.document-markdown-preview',
      '.kition-rich-editor__content',
      '.document-editor',
      '.cm-content',
    ].join(', ')).first().waitFor({ state: 'visible', timeout: 15_000 })

    await page.locator('.document-editor .cm-editor').evaluate((editor) => {
      const menu = document.createElement('div')
      menu.className = 'cm-tooltip cm-tooltip-autocomplete'
      menu.dataset.testid = 'completion-contrast-probe'
      menu.style.position = 'absolute'
      menu.style.left = '24px'
      menu.style.top = '24px'
      menu.innerHTML = [
        '<ul role="listbox">',
        '<li><span class="cm-completionLabel">Reference</span><span class="cm-completionDetail">docs/reference</span></li>',
        '<li aria-selected="true"><span class="cm-completionLabel">README</span><span class="cm-completionDetail">docs/README</span></li>',
        '</ul>',
      ].join('')
      editor.append(menu)
    })

    const completionMenu = page.getByTestId('completion-contrast-probe')
    await expect(completionMenu).toBeVisible()
    const { surfaceContrastReport, completionContrastReport } = await page.evaluate(() => {
      const parseRgb = (value: string) => {
        const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
        if (!match) return null
        return {
          r: Number(match[1]),
          g: Number(match[2]),
          b: Number(match[3]),
          a: match[4] === undefined ? 1 : Number(match[4]),
        }
      }
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      }
      const luminance = (rgb: { r: number; g: number; b: number }) =>
        0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
      const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
        const l1 = luminance(a)
        const l2 = luminance(b)
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      }
      const effectiveBackground = (element: Element) => {
        let current: Element | null = element
        while (current) {
          const background = parseRgb(getComputedStyle(current).backgroundColor)
          if (background && background.a > 0) return background
          current = current.parentElement
        }
        return { r: 255, g: 255, b: 255 }
      }
      const surfaceContrastReport = [
        '.document-editor-panel',
        '.document-rich-editor .kition-rich-editor__content',
        '.document-markdown-preview',
        '.document-editor',
        '.document-editor .cm-content',
      ].flatMap((selector) => {
        const element = document.querySelector(selector)
        if (!element) return []
        const foreground = parseRgb(getComputedStyle(element).color)
        const background = effectiveBackground(element)
        if (!foreground) return []
        return [{
          selector,
          color: getComputedStyle(element).color,
          backgroundColor: `rgb(${background.r}, ${background.g}, ${background.b})`,
          contrast: contrast(foreground, background),
        }]
      })
      const menu = document.querySelector<HTMLElement>('[data-testid="completion-contrast-probe"]')
      if (!menu) return { surfaceContrastReport, completionContrastReport: [] }
      const menuBackground = parseRgb(getComputedStyle(menu).backgroundColor)
      if (!menuBackground) return { surfaceContrastReport, completionContrastReport: [] }

      const completionContrastReport = Array.from(menu.querySelectorAll<HTMLElement>('li')).map((row) => {
        const rowStyle = getComputedStyle(row)
        const rowBackgroundCandidate = parseRgb(rowStyle.backgroundColor)
        const rowBackground = rowBackgroundCandidate && rowBackgroundCandidate.a > 0
          ? rowBackgroundCandidate
          : menuBackground
        const rowForeground = parseRgb(rowStyle.color)
        const detail = row.querySelector<HTMLElement>('.cm-completionDetail')
        const detailStyle = detail ? getComputedStyle(detail) : null
        const detailForeground = detailStyle ? parseRgb(detailStyle.color) : null
        const detailOpacity = detailStyle ? Number(detailStyle.opacity) : 1
        const visibleDetailForeground = detailForeground
          ? {
              r: detailForeground.r * detailOpacity + rowBackground.r * (1 - detailOpacity),
              g: detailForeground.g * detailOpacity + rowBackground.g * (1 - detailOpacity),
              b: detailForeground.b * detailOpacity + rowBackground.b * (1 - detailOpacity),
            }
          : null

        return {
          selected: row.hasAttribute('aria-selected'),
          backgroundColor: rowBackgroundCandidate && rowBackgroundCandidate.a > 0
            ? rowStyle.backgroundColor
            : getComputedStyle(menu).backgroundColor,
          textContrast: rowForeground ? contrast(rowForeground, rowBackground) : 0,
          detailContrast: visibleDetailForeground ? contrast(visibleDetailForeground, rowBackground) : null,
        }
      })

      return { surfaceContrastReport, completionContrastReport }
    })

    expect(surfaceContrastReport.length).toBeGreaterThan(1)
    for (const item of surfaceContrastReport) {
      expect(item.contrast, `${item.selector}: ${item.color} on ${item.backgroundColor}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(completionContrastReport.length).toBeGreaterThan(1)
    for (const item of completionContrastReport) {
      expect(item.textContrast).toBeGreaterThanOrEqual(4.5)
      if (item.detailContrast != null) {
        expect(item.detailContrast).toBeGreaterThanOrEqual(4.5)
      }
    }
    expect(completionContrastReport.find((item) => item.selected)?.backgroundColor).toBe('rgb(86, 69, 212)')
  })

  test('opens a new agent chat from the current document workspace', async ({ page }) => {
    const sessionRequests: Array<Record<string, unknown>> = []
    await page.route('**/api/v1/agent/sessions', async (route) => {
      if (route.request().method() === 'POST') {
        sessionRequests.push(route.request().postDataJSON() as Record<string, unknown>)
      }
      await route.fallback()
    })

    await page.goto('/')
    await expect(page).toHaveURL(/\/documents$/)

    await page.getByRole('button', { name: 'Open AI Chat' }).click()
    await page.getByRole('button', { name: 'New chat' }).click()

    await expect(page.getByRole('tab', { name: 'New chat', selected: true })).toBeVisible()
    await expect(page.getByPlaceholder('Plan, write, or ask anything…')).toBeVisible()
    expect(sessionRequests.at(-1)).toMatchObject({ language: 'English' })
  })

  test('removed workspace and admin routes return to documents', async ({ page }) => {
    for (const path of ['/writing', '/image', '/video', '/history', '/templates', '/settings/oauth', '/admin/model-usage']) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/documents$/)
      await expect(page.getByTestId('document-tree')).toBeVisible()
    }
  })

  test('connects, refreshes, and disconnects a Kition Account from the profile page', async ({ page }) => {
    const secureStore = new Map<string, string>()
    const openedExternalURLs: string[] = []
    let portalResultCalls = 0
    let portalStatusCalls = 0
    const portalStatusBalances: number[] = []
    let revoked = false
    let billingOpened = false

    await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
      secureStore.set(key, value)
    })
    await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
    await page.exposeFunction('__desktopDeleteSecureValue', async (key: string) => {
      secureStore.delete(key)
    })
    await page.exposeFunction('__desktopOpenExternalURL', async (targetURL: string) => {
      openedExternalURLs.push(targetURL)
      if (targetURL === 'https://billing.kition.ai/manage') {
        billingOpened = true
      }
    })
    await mockDesktopAccountBridge(page)

    await page.route('**/api/v1/desktop/portal/connect/start', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: {
            session_id: 'portal-session',
            authorize_url: 'https://platform.example.com/api/oauth/desktop/authorize?challenge_id=portal-session',
            expires_at: 1_780_617_600_000,
            poll_interval_ms: 10,
          },
        }),
      })
    })

    await page.route('**/api/v1/desktop/portal/connect/result/portal-session', async (route) => {
      portalResultCalls += 1
      const payload = portalResultCalls < 2
        ? {
            code: 200,
            data: {
              status: 'pending',
              expires_at: 1_780_617_600_000,
            },
          }
        : {
            code: 200,
            data: {
              status: 'completed',
              expires_at: 1_780_617_600_000,
              session: {
                access_token: 'portal-token',
                token_prefix: 'portal-token',
                user_id: 7,
                user_email: 'portal@example.com',
                expires_at: 1_780_704_000_000,
                credit_total: 150,
                credit_balance: 87,
                credit_spent: 63,
                period_credit_total: 100,
                period_credit_balance: 60,
                period_credit_spent: 40,
                wallet_credit_total: 50,
                wallet_credit_balance: 27,
                wallet_credit_spent: 23,
                plan_code: 'basic',
                plan_display_name: 'Kition Basic',
                plan_type: 'subscription',
                subscription_status: 'active',
                credit_purchased_total: 50,
                credit_granted_total: 100,
                lifetime_credit_total: 150,
                credit_reset_cycle: 'none',
                credit_reset_at: null,
                billing_url: 'https://billing.kition.ai/manage',
                topup_url: 'https://billing.kition.ai/topup',
              },
            },
          }

      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    })

    await page.route('**/api/v1/desktop/portal/session/status', async (route) => {
      portalStatusCalls += 1
      portalStatusBalances.push(billingOpened ? 99 : 87)
      const payload = revoked
        ? {
            code: 200,
            data: {
              authenticated: false,
            },
          }
        : {
            code: 200,
            data: {
              authenticated: true,
              user_id: 7,
              user_email: 'portal@example.com',
              token_prefix: 'portal-token',
              expires_at: 1_780_704_000_000,
              credit_total: 150,
              credit_balance: billingOpened ? 99 : 87,
              credit_spent: billingOpened ? 51 : 63,
              period_credit_total: 100,
              period_credit_balance: 60,
              period_credit_spent: 40,
              wallet_credit_total: 50,
              wallet_credit_balance: 27,
              wallet_credit_spent: 23,
              plan_code: 'basic',
              plan_display_name: 'Kition Basic',
              plan_type: 'subscription',
              subscription_status: 'active',
              credit_purchased_total: 50,
              credit_granted_total: 100,
              lifetime_credit_total: 150,
              credit_reset_cycle: 'none',
              credit_reset_at: null,
              billing_url: 'https://billing.kition.ai/manage',
              topup_url: 'https://billing.kition.ai/topup',
            },
          }

      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    })

    await page.route('**/api/v1/desktop/portal/logout', async (route) => {
      revoked = true
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: {
            success: true,
          },
        }),
      })
    })

    await page.goto('/')

    await expect(page.getByTestId('portal-account-button')).toHaveCount(0)
    await expect(page.getByTestId('portal-credit-summary')).toHaveCount(0)
    const profileNavButton = page.getByTestId('profile-nav-button')
    await expect(profileNavButton).toBeVisible()
    await profileNavButton.click()

    await expect(page.getByTestId('portal-profile-page')).toBeVisible()
    const accountLogoFrameLocator = page.locator('.kition-account-panel__icon')
    await expect(accountLogoFrameLocator).toHaveCSS('width', '48px')
    const accountLogoFrame = await accountLogoFrameLocator.boundingBox()
    const accountLogo = await page.locator('.kition-account-panel__icon img').boundingBox()
    expect(accountLogoFrame).not.toBeNull()
    expect(accountLogo).not.toBeNull()
    expect(Math.abs(accountLogo!.width - accountLogoFrame!.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(accountLogo!.height - accountLogoFrame!.height)).toBeLessThanOrEqual(1)
    const portalButton = page.getByTestId('portal-account-button')
    await expect(portalButton).toHaveText('Sign in to Kition')

    await portalButton.click()

    await expect.poll(() => openedExternalURLs.slice()).toEqual([
      'https://platform.example.com/api/oauth/desktop/authorize?challenge_id=portal-session',
    ])
    await expect(page.getByTestId('portal-account-summary')).toContainText('portal@example.com')
    await expect(page.getByTestId('portal-account-summary')).toContainText('Kition Basic')
    await expect(page.getByTestId('portal-account-summary')).toContainText('Plan credits')
    await expect(page.getByTestId('portal-account-summary')).toContainText('60 / 100')
    await expect(page.getByTestId('portal-account-summary')).toContainText('Purchased credits')
    await expect(page.getByTestId('portal-account-summary')).toContainText('27 / 50')
    await expect(page.getByTestId('portal-profile-credit-summary')).toContainText('Credits')
    await expect(page.getByTestId('portal-profile-credit-summary')).toContainText('87 / 150')
    await expect(page.getByTestId('portal-profile-credit-summary')).toContainText('58%')
    await page.setViewportSize({ width: 420, height: 720 })
    const accountDialogBox = await page.getByRole('dialog', { name: 'Account info' }).boundingBox()
    expect(accountDialogBox).not.toBeNull()
    expect(accountDialogBox!.x).toBeGreaterThanOrEqual(0)
    expect(accountDialogBox!.y).toBeGreaterThanOrEqual(0)
    expect(accountDialogBox!.x + accountDialogBox!.width).toBeLessThanOrEqual(420)
    expect(accountDialogBox!.y + accountDialogBox!.height).toBeLessThanOrEqual(720)
    await expect(page.getByTestId('kition-account-manage-plan')).toBeVisible()
    await page.setViewportSize({ width: 1280, height: 720 })
    // Compact badge in the workspace sidebar is single-row to match the height
    // of the sibling icon buttons; the X / Y and percentage move into the
    // `title` attribute for hover-discoverable detail.
    const compactCreditSummary = page.getByTestId('portal-credit-summary')
    const compactCreditLabel = compactCreditSummary.locator('.credit-usage-card__label')
    await expect(compactCreditLabel).toHaveCSS('position', 'absolute')
    await expect(compactCreditLabel).toHaveCSS('width', '1px')
    await expect(compactCreditSummary.locator('.credit-usage-card__amount')).toHaveText('87')
    await expect(compactCreditSummary).toHaveAttribute('title', /87 \/ 150/)
    await expect(compactCreditSummary).toHaveAttribute('title', /58% remaining/)
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toContain('"portal@example.com"')
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toContain('"credit_total":150')

    const statusCallsBeforeBilling = portalStatusCalls
    await page.getByTestId('kition-account-manage-plan').click()
    await expect.poll(() => openedExternalURLs.at(-1)).toBe('https://billing.kition.ai/manage')
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })
    await expect.poll(() => portalStatusCalls).toBeGreaterThan(statusCallsBeforeBilling)
    await expect.poll(() => portalStatusBalances.at(-1)).toBe(99)
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toContain('"credit_balance":99')
    await expect(page.getByTestId('portal-profile-credit-summary')).toContainText('99 / 150')

    const statusCallsBeforeReload = portalStatusCalls
    await page.reload()
    await expect.poll(() => portalStatusCalls).toBeGreaterThan(statusCallsBeforeReload)
    await expect.poll(() => portalStatusBalances.at(-1)).toBe(99)
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toContain('"credit_balance":99')
    await expect(compactCreditSummary.locator('.credit-usage-card__amount')).toHaveText('99')
    await expect(compactCreditSummary).toHaveAttribute('title', /66% remaining/)
    await page.getByTestId('profile-nav-button').click()
    await expect(page.getByTestId('portal-account-summary')).toContainText('portal@example.com')

    await page.getByTestId('portal-account-logout-button').click()
    await expect(page.getByTestId('portal-account-button')).toContainText('Sign in to Kition')
    await expect(page.getByTestId('portal-credit-summary')).toHaveCount(0)
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toBe('')
  })

  test('restores a persisted portal account on shell startup', async ({ page }) => {
    const secureStore = new Map<string, string>([
      [
        'kition.portal.account.session.v1',
        JSON.stringify({
          access_token: 'startup-token',
          token_prefix: 'startup',
          user_id: 7,
          user_email: 'old@example.com',
          expires_at: 1_780_617_600_000,
        }),
      ],
      [
        'kition.desktop.settings.v1',
        JSON.stringify({
          providers: {
            openai: { enabled: true, label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', discoveredModels: ['gpt-4.1'] },
            kition_console: { enabled: false, label: 'Kition Console', discoveredModels: ['gpt-5.5'] },
          },
          models: {
            activeProvider: 'openai',
            selectedModelByProvider: { openai: 'gpt-4.1' },
          },
        }),
      ],
    ])
    let statusRequests = 0

    await page.exposeFunction('__desktopWriteSecureValue', async (key: string, value: string) => {
      secureStore.set(key, value)
    })
    await page.exposeFunction('__desktopReadSecureValue', async (key: string) => secureStore.get(key) || '')
    await page.exposeFunction('__desktopDeleteSecureValue', async (key: string) => {
      secureStore.delete(key)
    })
    await mockDesktopAccountBridge(page)

    await page.route('**/api/v1/desktop/portal/session/status', async (route) => {
      statusRequests += 1
      expect(route.request().postDataJSON()).toMatchObject({
        access_token: 'startup-token',
      })
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: 200,
          data: {
            authenticated: true,
            user_id: 7,
            user_email: 'startup@example.com',
            token_prefix: 'startup',
            expires_at: 1_780_704_000_000,
            credit_total: 150,
            credit_balance: 87,
            credit_spent: 63,
          },
        }),
      })
    })

    await page.goto('/')

    await expect.poll(() => statusRequests).toBe(1)
    await expect.poll(() => secureStore.get('kition.portal.account.session.v1') || '').toContain('"user_email":"startup@example.com"')
    await expect.poll(() => secureStore.get('kition.desktop.settings.v1') || '').toContain('"activeProvider":"kition_console"')
  })

  test('opens the welcome guide directly from local first-run onboarding', async ({ page }) => {
    const onboardingKey = getWorkspaceStorageKey('browser-local-workspace', 'onboarding.v1')
    await page.addInitScript(({ key }) => {
      localStorage.setItem(key, JSON.stringify({
        version: 1,
        status: 'pending',
        updatedAt: '2026-07-22T00:00:00.000Z',
      }))
      localStorage.setItem('kition.workspace.documents.v1', JSON.stringify({
        'Getting Started/Welcome to Kition.md': {
          content: '# Welcome to Kition\n\nChoose a template and make it your own.',
          updated_at: '2026-07-22T00:00:00.000Z',
        },
      }))
      localStorage.setItem('kition.workspace.folders.v1', JSON.stringify(['Getting Started']))
    }, { key: onboardingKey })

    await page.goto('/')
    await expect(page.getByTestId('first-run-start-local')).toBeVisible()
    await page.getByTestId('first-run-start-local').click()

    await expect(page.getByTestId('first-run-activation')).toHaveCount(0)
    await expect(page.getByText('Welcome to Kition', { exact: true }).first()).toBeVisible()
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), onboardingKey)).toContain('"providerChoice":"local"')
  })

  test('completes and reopens the per-workspace first-run guide across themes', async ({ page }) => {
    const onboardingKey = getWorkspaceStorageKey('browser-local-workspace', 'onboarding.v1')
    await page.addInitScript(({ key }) => {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, JSON.stringify({
          version: 1,
          status: 'pending',
          updatedAt: '2026-07-19T06:00:00.000Z',
        }))
      }
    }, { key: onboardingKey })

    await page.goto('/')
    await expect(page.getByTestId('first-run-activation')).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.setViewportSize({ width: 420, height: 720 })
    const darkDialogBox = await page.getByTestId('first-run-activation').boundingBox()
    expect(darkDialogBox).not.toBeNull()
    expect(darkDialogBox!.x).toBeGreaterThanOrEqual(0)
    expect(darkDialogBox!.y).toBeGreaterThanOrEqual(0)
    expect(darkDialogBox!.x + darkDialogBox!.width).toBeLessThanOrEqual(420)
    expect(darkDialogBox!.y + darkDialogBox!.height).toBeLessThanOrEqual(720)

    await page.getByTestId('first-run-configure-models').click()

    await expect(page.getByRole('heading', { name: 'AI Providers' })).toBeVisible()
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), onboardingKey)).toContain('"status":"completed"')
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), onboardingKey)).toContain('"providerChoice":"byo"')

    await page.getByRole('button', { name: 'Display', exact: true }).click()
    await page.getByRole('button', { name: 'Light', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByTestId('reopen-getting-started').click()
    await expect(page.getByTestId('first-run-activation')).toBeVisible()
    const lightDialogBox = await page.getByTestId('first-run-activation').boundingBox()
    expect(lightDialogBox).not.toBeNull()
    expect(lightDialogBox!.x + lightDialogBox!.width).toBeLessThanOrEqual(420)
    expect(lightDialogBox!.y + lightDialogBox!.height).toBeLessThanOrEqual(720)

    await page.getByRole('button', { name: 'Skip for now' }).click()
    await page.reload()
    await expect(page.getByTestId('first-run-activation')).toHaveCount(0)
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), onboardingKey)).toContain('"providerChoice":"byo"')
  })
})
