import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { getWorkspaceStorageKey } from '../src/features/onboarding/workspaceStorageKey'
import {
  buildBoardDocument,
  serializeBoardDocument,
} from '../src/features/whiteboard/lib/boardSerialization'
import { createBoardRecordsFromElements } from '../src/features/whiteboard/lib/boardRecords'

const CAPTURE_ENABLED = process.env.KITION_CAPTURE_README_ASSETS === '1'
const VAULT_PATH = '/tmp/Kition Demo'
const WELCOME_PATH = 'Getting Started/Welcome to Kition.md'
const TABLE_PATH = 'Content Pipeline.kitable'
const BOARD_PATH = 'Product Launch.kiboard'
const WELCOME_CONTENT = readFileSync(new URL('../public/onboarding/welcome.md', import.meta.url), 'utf8')
const LOGO_CONTENT = readFileSync(new URL('../public/onboarding/logo.png', import.meta.url))
const BOARD_CONTENT = serializeBoardDocument(buildBoardDocument({
  title: 'Product Launch',
  viewport: { x: 0, y: 0, zoom: 1 },
  records: createBoardRecordsFromElements([
    {
      id: 'research-to-strategy',
      kind: 'connector',
      start: { x: 230, y: 145 },
      end: { x: 300, y: 220 },
      style: { strokeColor: 'blue' },
    },
    {
      id: 'strategy-to-message',
      kind: 'connector',
      start: { x: 480, y: 220 },
      end: { x: 540, y: 145 },
      style: { strokeColor: 'green' },
    },
    {
      id: 'strategy-to-audience',
      kind: 'connector',
      start: { x: 300, y: 260 },
      end: { x: 230, y: 335 },
      style: { strokeColor: 'orange' },
    },
    {
      id: 'strategy-to-channels',
      kind: 'connector',
      start: { x: 480, y: 260 },
      end: { x: 540, y: 335 },
      style: { strokeColor: 'orange' },
    },
    {
      id: 'research',
      kind: 'rectangle',
      x: 80,
      y: 100,
      width: 150,
      height: 90,
      text: 'Research',
      style: { fillColor: 'blue', strokeColor: 'blue' },
    },
    {
      id: 'launch-strategy',
      kind: 'rectangle',
      x: 300,
      y: 195,
      width: 180,
      height: 90,
      text: 'Launch strategy',
      style: { fillColor: 'purple', strokeColor: 'purple' },
    },
    {
      id: 'messaging',
      kind: 'rectangle',
      x: 540,
      y: 100,
      width: 120,
      height: 90,
      text: 'Messaging',
      style: { fillColor: 'green', strokeColor: 'green' },
    },
    {
      id: 'audience',
      kind: 'rectangle',
      x: 80,
      y: 290,
      width: 150,
      height: 90,
      text: 'Audience',
      style: { fillColor: 'orange', strokeColor: 'orange' },
    },
    {
      id: 'channels',
      kind: 'rectangle',
      x: 540,
      y: 290,
      width: 120,
      height: 90,
      text: 'Channels',
      style: { fillColor: 'orange', strokeColor: 'orange' },
    },
    {
      id: 'x-box-example',
      kind: 'rectangle',
      x: 80,
      y: 430,
      width: 92,
      height: 72,
      shapeType: 'x-box',
      style: { fillStyle: 'none', strokeColor: 'red' },
    },
    {
      id: 'x-box-label',
      kind: 'text',
      x: 190,
      y: 474,
      text: 'Needs revision',
      fontSize: 18,
      style: { strokeColor: 'red' },
    },
    {
      id: 'check-box-example',
      kind: 'rectangle',
      x: 280,
      y: 430,
      width: 92,
      height: 72,
      shapeType: 'check-box',
      style: { fillStyle: 'none', strokeColor: 'green' },
    },
    {
      id: 'check-box-label',
      kind: 'text',
      x: 390,
      y: 474,
      text: 'Ready to launch',
      fontSize: 18,
      style: { strokeColor: 'green' },
    },
  ], 'Product Launch'),
}))

async function mockReadmeWorkspace(page: Page, activePath = WELCOME_PATH) {
  await page.addInitScript(
    ({ boardContent, boardPath, vaultPath, welcomePath, tablePath, welcomeContent }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const updatedAt = '2026-07-24T00:00:00.000Z'
      const vault = {
        path: vaultPath,
        name: 'Kition Demo',
        added_at: updatedAt,
        last_opened_at: updatedAt,
      }
      const makeRegistry = () => ({ vaults: [vault], active_vault_path: vaultPath })
      const makeListResponse = () => ({
        root_path: vaultPath,
        items: [
          {
            type: 'file' as const,
            path: boardPath,
            name: boardPath,
            format: 'board' as const,
            size: boardContent.length,
            updated_at: updatedAt,
          },
          {
            type: 'file' as const,
            path: tablePath,
            name: tablePath,
            format: 'kitable' as const,
            size: 2048,
            updated_at: updatedAt,
          },
          {
            type: 'file' as const,
            path: welcomePath,
            name: welcomePath,
            format: 'markdown' as const,
            size: welcomeContent.length,
            updated_at: updatedAt,
          },
        ],
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
          installation_id: 'readme-capture-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'readme-capture-installation',
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
        ReadWorkspaceDocument: async (request: { path: string }) => {
          if (request.path === boardPath) {
            return {
              path: boardPath,
              name: boardPath,
              content: boardContent,
              format: 'board',
              updated_at: updatedAt,
              size: boardContent.length,
            }
          }
          if (request.path !== welcomePath) throw new Error(`document not found: ${request.path}`)
          return {
            path: welcomePath,
            name: welcomePath,
            content: welcomeContent,
            format: 'markdown',
            updated_at: updatedAt,
            size: welcomeContent.length,
          }
        },
        WriteWorkspaceDocument: async (request: { path: string; content: string }) => ({
          path: request.path,
          name: request.path.split('/').pop() || request.path,
          content: request.content,
          format: 'markdown',
          updated_at: updatedAt,
          size: request.content.length,
        }),
      }
    },
    {
      vaultPath: VAULT_PATH,
      boardPath: BOARD_PATH,
      boardContent: BOARD_CONTENT,
      welcomePath: WELCOME_PATH,
      tablePath: TABLE_PATH,
      welcomeContent: WELCOME_CONTENT,
    },
  )

  await page.addInitScript(({ activePath, onboardingKey }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', activePath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
    window.localStorage.setItem('kition.document.layout.sideOpen', '0')
    window.localStorage.setItem(onboardingKey, JSON.stringify({
      version: 1,
      status: 'completed',
      providerChoice: 'byo',
      updatedAt: '2026-07-24T00:00:00.000Z',
    }))
    window.localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify({
      providers: {
        openai: {
          enabled: true,
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          discoveredModels: ['gpt-5.5'],
        },
      },
      models: {
        activeProvider: 'openai',
        selectedModelByProvider: { openai: 'gpt-5.5' },
      },
    }))
  }, {
    activePath,
    onboardingKey: getWorkspaceStorageKey(VAULT_PATH, 'onboarding.v1'),
  })
}

test('captures README product screenshots from the onboarding source', async ({ page }) => {
  test.skip(!CAPTURE_ENABLED, 'Run through pnpm capture:readme:assets.')

  await mockLocalWorkspaceApi(page)
  await mockReadmeWorkspace(page)
  await page.route('**/workspace-files/Getting%20Started/logo.png', async (route) => {
    await route.fulfill({ body: LOGO_CONTENT, contentType: 'image/png' })
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1200, height: 750 })
  await page.goto('/documents')

  await expect(page.getByTestId('document-editor')).toBeVisible()
  await expect(page.getByText('Start with one useful action')).toBeVisible()
  await page.locator('.document-editor .cm-scroller').evaluate((element) => {
    element.scrollTop = 380
  }).catch(() => {})
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'docs/readme/documents.png' })

  await page.getByRole('button', { name: 'Open AI Chat' }).click()
  await page.getByRole('button', { name: 'New chat' }).click()
  const composer = page.getByPlaceholder('Plan, write, or ask anything…')
  await expect(composer).toBeVisible()
  await composer.fill('Research AI workspace trends and turn the findings into an editorial plan.')
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'docs/readme/agent.png' })
})

test('captures README whiteboard screenshot from the real product surface', async ({ page }) => {
  test.skip(!CAPTURE_ENABLED, 'Run through pnpm capture:readme:assets.')

  await mockLocalWorkspaceApi(page)
  await mockReadmeWorkspace(page)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1200, height: 750 })
  await page.goto('/documents')

  await page.getByText(BOARD_PATH, { exact: true }).click()
  await expect(page.getByTestId('whiteboard-svg-scene')).toBeVisible()
  await page.locator('[data-tab-title="Getting Started/Welcome to Kition"]')
    .getByRole('button', { name: 'Close tab' })
    .click()
  await page.locator('[data-element-id="launch-strategy"]').click()
  await page.getByTestId('whiteboard-selection-move-area').dblclick()
  await expect(page.getByTestId('whiteboard-text-editor')).toBeVisible()
  await page.getByTestId('whiteboard-text-editor').fill('Launch strategy')
  await page.getByTestId('whiteboard-text-editor').press('Enter')
  await expect(page.getByTestId('whiteboard-text-editor')).toBeHidden()
  await expect(page.locator('[data-element-id="launch-strategy"]')).toContainText('Launch strategy')
  await page.getByTestId('whiteboard-shape-menu-trigger').click()
  await expect(page.getByTestId('whiteboard-shape-x-box')).toBeVisible()
  await expect(page.getByTestId('whiteboard-shape-check-box')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'docs/readme/whiteboards.png' })

  await page.route('**/docs/readme/whiteboards.webp', async (route) => {
    await route.fulfill({
      body: readFileSync('docs/readme/whiteboards.png'),
      contentType: 'image/png',
    })
  })
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/docs/readme/kition-overview.svg')
  await expect(page.locator('svg')).toBeVisible()
  await page.screenshot({ path: 'docs/readme/kition-overview.png' })
})
