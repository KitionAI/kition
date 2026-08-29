import { expect, type Page } from '@playwright/test'

import { getWorkspaceStorageKey } from '../../src/features/onboarding/workspaceStorageKey'
import {
  buildBoardDocument,
  serializeBoardDocument,
} from '../../src/features/whiteboard/lib/boardSerialization'
import {
  createBoardRecordsFromElements,
  type BoardRecord,
} from '../../src/features/whiteboard/lib/boardRecords'
import type { WhiteboardElement } from '../../src/features/whiteboard/lib/whiteboardTypes'
import type { WhiteboardTestSnapshot } from '../../src/features/whiteboard/testing/whiteboardTestBridge'
import { mockLocalWorkspaceApi } from './mockApi'

export const WHITEBOARD_E2E_PATH = 'Whiteboard E2E.kiboard'
const WHITEBOARD_E2E_VAULT = '/tmp/Kition Whiteboard E2E'
const BOARD_STORAGE_KEY = 'kition.e2e.whiteboard.content'

export const DEFAULT_WHITEBOARD_ELEMENTS: WhiteboardElement[] = [
  {
    id: 'node-a',
    kind: 'rectangle',
    x: 120,
    y: 140,
    width: 160,
    height: 100,
    text: 'Alpha',
    shapeStyle: 'mind-node',
  },
  {
    id: 'node-b',
    kind: 'rectangle',
    x: 420,
    y: 140,
    width: 160,
    height: 100,
    text: 'Beta',
    shapeStyle: 'mind-node',
  },
  {
    id: 'node-c',
    kind: 'rectangle',
    x: 720,
    y: 320,
    width: 160,
    height: 100,
    text: 'Gamma',
    shapeStyle: 'flow-node',
  },
]

export async function openWhiteboardFixture(page: Page, options: {
  agentAvailable?: boolean
  elements?: WhiteboardElement[]
  records?: BoardRecord[]
} = {}) {
  const records = options.records
    || createBoardRecordsFromElements(options.elements || DEFAULT_WHITEBOARD_ELEMENTS, 'Whiteboard E2E')
  const content = serializeBoardDocument(buildBoardDocument({
    title: 'Whiteboard E2E',
    viewport: { x: 0, y: 0, zoom: 1 },
    records,
  }))

  await mockLocalWorkspaceApi(page)
  await installWhiteboardDesktopBridge(page, content, options.agentAvailable !== false)
  await page.goto('/documents')
  await page.getByText(WHITEBOARD_E2E_PATH, { exact: true }).click()
  await expect(page.getByTestId('whiteboard-svg-scene')).toBeVisible()
  await expect.poll(async () => page.evaluate(() => Boolean(window.__KITION_WHITEBOARD_TEST__))).toBe(true)
}

export async function readWhiteboardSnapshot(page: Page) {
  return page.evaluate(() => {
    if (!window.__KITION_WHITEBOARD_TEST__) throw new Error('Whiteboard test bridge is unavailable')
    return window.__KITION_WHITEBOARD_TEST__.read()
  }) as Promise<WhiteboardTestSnapshot>
}

export async function readWhiteboardElements(page: Page) {
  const snapshot = await readWhiteboardSnapshot(page)
  return snapshot.records.filter((record) => record.record_type === 'element')
}

async function installWhiteboardDesktopBridge(
  page: Page,
  initialContent: string,
  agentAvailable: boolean,
) {
  await page.addInitScript(
    ({ boardPath, initialBoardContent, storageKey, vaultPath, whiteboardCapability }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const updatedAt = '2026-08-27T00:00:00.000Z'
      const vault = {
        path: vaultPath,
        name: 'Kition Whiteboard E2E',
        added_at: updatedAt,
        last_opened_at: updatedAt,
      }
      if (!window.localStorage.getItem(storageKey)) {
        window.localStorage.setItem(storageKey, initialBoardContent)
      }
      const readContent = () => window.localStorage.getItem(storageKey) || initialBoardContent
      const registry = () => ({ vaults: [vault], active_vault_path: vaultPath })
      const list = () => ({
        root_path: vaultPath,
        items: [{
          type: 'file' as const,
          path: boardPath,
          name: boardPath,
          format: 'board' as const,
          size: readContent().length,
          updated_at: updatedAt,
        }],
      })

      stateWindow.kitionDesktop = {
        shell: 'electron',
        DesktopInfo: async () => ({
          is_desktop: true,
          platform: 'darwin',
          backend_base_url: 'http://127.0.0.1:18101/api',
          data_dir: '/tmp/kition-e2e/data',
          cache_dir: '/tmp/kition-e2e/cache',
          logs_dir: '/tmp/kition-e2e/logs',
          uploads_dir: '/tmp/kition-e2e/uploads',
          exports_dir: '/tmp/kition-e2e/exports',
          workspace_dir: vaultPath,
          supports_secure_storage: true,
        }),
        BackendStatus: async () => ({
          base_url: 'http://127.0.0.1:18101/api',
          health_url: 'http://127.0.0.1:18101/health',
          running: true,
          last_error: '',
          logs: '',
          log_file: '',
          launch_mode: 'managed',
          binary_path: '',
          config_path: '',
          working_dir: '',
          command: '',
          capabilities: whiteboardCapability ? ['agent_whiteboard_v1'] : [],
        }),
        BootstrapInitialize: async () => ({
          installation_id: 'whiteboard-e2e',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'whiteboard-e2e',
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
        OpenExternalURL: async () => {},
        OpenRuntimePath: async () => {},
        ListVaults: async () => registry(),
        AddVault: async () => ({ vault, registry: registry() }),
        RemoveVault: async () => registry(),
        RenameVault: async () => ({ vault, registry: registry() }),
        SetActiveVault: async () => ({ list: list(), registry: registry() }),
        ChooseDirectory: async () => ({ canceled: true, path: '' }),
        ListWorkspaceDocuments: async () => list(),
        ReadWorkspaceDocument: async (request: { path: string }) => {
          const content = readContent()
          return {
            path: request.path,
            name: request.path.split('/').pop() || request.path,
            content,
            format: 'board',
            updated_at: updatedAt,
            size: content.length,
          }
        },
        WriteWorkspaceDocument: async (request: { path: string; content: string }) => {
          window.localStorage.setItem(storageKey, request.content)
          return {
            path: request.path,
            name: request.path.split('/').pop() || request.path,
            content: request.content,
            format: 'board',
            updated_at: updatedAt,
            size: request.content.length,
          }
        },
        ImportWorkspaceFile: async (request: { folder?: string; filename: string }) => ({
          imported_path: `${String(request.folder || '').replace(/^\/+|\/+$/g, '')}/${request.filename}`
            .replace(/^\//, ''),
        }),
      }
    },
    {
      boardPath: WHITEBOARD_E2E_PATH,
      initialBoardContent: initialContent,
      storageKey: BOARD_STORAGE_KEY,
      vaultPath: WHITEBOARD_E2E_VAULT,
      whiteboardCapability: agentAvailable,
    },
  )

  await page.addInitScript(({ activePath, onboardingKey }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', activePath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.setItem('kition.document.layout.sideOpen', '0')
    window.localStorage.setItem(onboardingKey, JSON.stringify({
      version: 1,
      status: 'completed',
      providerChoice: 'byo',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }))
    window.localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify({
      providers: {
        openai: {
          enabled: true,
          label: 'OpenAI',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'test-key',
          wireApi: 'responses',
          discoveredModels: ['gpt-test'],
        },
      },
      models: {
        activeProvider: 'openai',
        selectedModelByProvider: { openai: 'gpt-test' },
      },
    }))
  }, {
    activePath: WHITEBOARD_E2E_PATH,
    onboardingKey: getWorkspaceStorageKey(WHITEBOARD_E2E_VAULT, 'onboarding.v1'),
  })
}
