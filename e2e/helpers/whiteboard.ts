import { expect, type Page } from '@playwright/test'

import { getWorkspaceStorageKey } from '../../src/features/onboarding/workspaceStorageKey'
import {
  createBoardRecordsFromElements,
  type BoardRecord,
} from '../../packages/board-editor/src/lib/boardRecords'
import type { WhiteboardElement } from '../../packages/board-editor/src/lib/whiteboardTypes'
import type { WhiteboardTestSnapshot } from '../../src/features/whiteboard/testing/whiteboardTestBridge'
import { mockLocalWorkspaceApi } from './mockApi'

export const WHITEBOARD_E2E_PATH = 'Whiteboard E2E.kiboard'
const WHITEBOARD_E2E_VAULT = '/tmp/Kition Whiteboard E2E'
const BOARD_STORAGE_KEY = 'kition.e2e.whiteboard.content'
const BOARD_TITLE = 'Whiteboard E2E'
/**
 * The app's `.kiboard` encoder, imported by the page from the Vite dev server: Playwright's own
 * TypeScript transform cannot load the KDM, so fixtures are encoded in the browser.
 */
const BOARD_FILE_MODULE = '/packages/board-editor/src/kdm/boardKdmFile.ts'
const BOARD_READ_MODULE = '/packages/board-editor/src/kdm/boardKdmRead.ts'
const BOARD_WRITE_MODULE = '/packages/board-editor/src/kdm/boardKdmWrite.ts'
const KDM_MODULE = '/src/lib/kdm/index.ts'
/** The event name the mock desktop bridge raises for a change to the board file on disk. */
const EXTERNAL_CHANGE_EVENT = 'kition-e2e:whiteboard-document-change'

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

/** The board file on disk in the mock desktop bridge, installed in the page before the app loads. */
type WhiteboardE2EFile = {
  read: () => string | null
  /** Replaces the file on disk without telling the app (see `emitChange`). */
  write: (content: string) => void
  /** Raises the desktop bridge's external-change event for the board file. */
  emitChange: () => void
  /** Writes the app made through `WriteWorkspaceDocument`, refused ones included. */
  writes: number
  /** `performance.now()` when the last write landed, or `null` before the first. */
  lastWriteAt: number | null
  /** When set, every `WriteWorkspaceDocument` call fails with this message. */
  failWrites: string | null
}

declare global {
  interface Window {
    __KITION_WHITEBOARD_E2E_FILE__?: WhiteboardE2EFile
  }
}

/** The board file as the app's own decoder reads it. */
export type WhiteboardFileContents = {
  /** The envelope's `version` field, or `null` when the text is not a JSON envelope. */
  envelopeVersion: number | null
  /** `'board'` when the app can open the file, or why it cannot. */
  state: 'board' | 'version-1' | 'newer-version' | 'not-a-board'
  docId: string | null
  records: BoardRecord[]
}

export async function openWhiteboardFixture(page: Page, options: {
  agentAvailable?: boolean
  elements?: WhiteboardElement[]
  records?: BoardRecord[]
  /** Raw file text served instead of a board built from `records`/`elements`. */
  fileContent?: string
  /** What the opened file shows: the canvas (default) or the read-only file notice. */
  expectView?: 'canvas' | 'notice'
} = {}) {
  const records = options.records
    || createBoardRecordsFromElements(options.elements || DEFAULT_WHITEBOARD_ELEMENTS, BOARD_TITLE)

  await mockLocalWorkspaceApi(page)
  await installWhiteboardDesktopBridge(page, records, options.agentAvailable !== false, options.fileContent ?? null)
  await page.goto('/documents')
  await page.getByText(WHITEBOARD_E2E_PATH, { exact: true }).click()
  await waitForWhiteboard(page, options.expectView || 'canvas')
}

/** Waits until the open board shows its canvas (with the test bridge) or its read-only notice. */
export async function waitForWhiteboard(page: Page, view: 'canvas' | 'notice' = 'canvas') {
  if (view === 'notice') {
    await expect(page.getByTestId('whiteboard-file-notice')).toBeVisible()
    return
  }
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

/** The board file's text on disk. */
export async function readWhiteboardFileText(page: Page) {
  return page.evaluate(() => window.__KITION_WHITEBOARD_E2E_FILE__?.read() ?? null)
}

/** How many writes the app has made to the board file. */
export async function countWhiteboardFileWrites(page: Page) {
  return page.evaluate(() => window.__KITION_WHITEBOARD_E2E_FILE__?.writes ?? 0)
}

/** Makes every later write to the board file fail with `message` (`null` lets writes through). */
export async function failWhiteboardFileWrites(page: Page, message: string | null) {
  await page.evaluate((failure) => {
    if (!window.__KITION_WHITEBOARD_E2E_FILE__) throw new Error('The whiteboard e2e file is unavailable')
    window.__KITION_WHITEBOARD_E2E_FILE__.failWrites = failure
  }, message)
}

/** Decodes the board file on disk with the app's `.kiboard` decoder and record reader. */
export async function readWhiteboardFile(page: Page): Promise<WhiteboardFileContents> {
  return page.evaluate(async ({ boardFileModule, boardReadModule, kdmModule }) => {
    const text = window.__KITION_WHITEBOARD_E2E_FILE__?.read()
    if (typeof text !== 'string') throw new Error('The whiteboard e2e file is unavailable')
    const load = (path: string) => import(/* @vite-ignore */ new URL(path, window.location.href).href)
    const [{ decodeBoardFile }, { readBoardRecords }, { randomActor }] = await Promise.all([
      load(boardFileModule),
      load(boardReadModule),
      load(kdmModule),
    ])
    let envelopeVersion: number | null = null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed.version === 'number') envelopeVersion = parsed.version
    } catch {
      envelopeVersion = null
    }
    const decoded = decodeBoardFile(text, randomActor())
    if (decoded.kind !== 'board') return { envelopeVersion, state: decoded.reason, docId: null, records: [] }
    return {
      envelopeVersion,
      state: 'board' as const,
      docId: decoded.replica.docId as string,
      records: JSON.parse(JSON.stringify(readBoardRecords(decoded.replica))),
    }
  }, { boardFileModule: BOARD_FILE_MODULE, boardReadModule: BOARD_READ_MODULE, kdmModule: KDM_MODULE }) as Promise<WhiteboardFileContents>
}

/**
 * Another writer's edit: decodes the board file on disk, adds `records` to it in one KDM
 * transaction of a different author (an element without a known page goes to the first page),
 * writes it back, and raises the external-change event the app listens to.
 */
export async function addRecordsToWhiteboardFileExternally(page: Page, records: BoardRecord[]) {
  await page.evaluate(async ({ added, boardFileModule, boardReadModule, boardWriteModule, kdmModule }) => {
    const file = window.__KITION_WHITEBOARD_E2E_FILE__
    const text = file?.read()
    if (!file || typeof text !== 'string') throw new Error('The whiteboard e2e file is unavailable')
    const load = (path: string) => import(/* @vite-ignore */ new URL(path, window.location.href).href)
    const [{ decodeBoardFile, encodeBoardFile }, { boardRootId, readBoardPageRecords }, { writeBoardDiff }, { person, randomActor }] = await Promise.all([
      load(boardFileModule),
      load(boardReadModule),
      load(boardWriteModule),
      load(kdmModule),
    ])
    const decoded = decodeBoardFile(text, randomActor())
    if (decoded.kind !== 'board') throw new Error(`The board file cannot be edited: ${decoded.reason}`)
    const replica = decoded.replica
    const pageIds = new Set(readBoardPageRecords(replica).map((record: { id: string }) => record.id))
    const firstPage = [...pageIds][0]
    const placed = added.map((record) => (
      record.record_type === 'element' && !pageIds.has(record.page_id) ? { ...record, page_id: firstPage } : record
    ))
    replica.transact(person('user:e2e-external'), (tx: unknown) => {
      writeBoardDiff(tx, boardRootId(replica), { added: placed, updated: [], removed: [] })
    })
    file.write(encodeBoardFile(replica))
    file.emitChange()
  }, {
    added: records,
    boardFileModule: BOARD_FILE_MODULE,
    boardReadModule: BOARD_READ_MODULE,
    boardWriteModule: BOARD_WRITE_MODULE,
    kdmModule: KDM_MODULE,
  })
}

async function installWhiteboardDesktopBridge(
  page: Page,
  records: BoardRecord[],
  agentAvailable: boolean,
  fileContent: string | null,
) {
  await page.addInitScript(
    ({
      boardFileModule,
      boardPath,
      boardRecords,
      boardTitle,
      externalChangeEvent,
      initialContent,
      kdmModule,
      storageKey,
      vaultPath,
      whiteboardCapability,
    }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const updatedAt = '2026-08-27T00:00:00.000Z'
      const vault = {
        path: vaultPath,
        name: 'Kition Whiteboard E2E',
        added_at: updatedAt,
        last_opened_at: updatedAt,
      }
      // The board file (a v2 `.kiboard`, unless the test gives raw text) is encoded on first read
      // and then kept in local storage, so it survives a reload. Module paths are resolved against
      // the page: WebKit resolves an init script's dynamic imports against the script itself.
      const readContent = async () => {
        const stored = window.localStorage.getItem(storageKey)
        if (stored !== null) return stored
        let content: string
        if (initialContent !== null) {
          content = initialContent
        } else {
          const [{ createBoardFromRecords, encodeBoardFile }, { randomActor }] = await Promise.all([
            import(/* @vite-ignore */ new URL(boardFileModule, window.location.href).href),
            import(/* @vite-ignore */ new URL(kdmModule, window.location.href).href),
          ])
          content = encodeBoardFile(createBoardFromRecords(boardTitle, randomActor(), boardRecords))
        }
        window.localStorage.setItem(storageKey, content)
        return content
      }
      const changeHandlers = new Set<(payload: { path: string; eventType: string; mtimeMs: number }) => void>()
      const file = {
        read: () => window.localStorage.getItem(storageKey),
        write: (content: string) => window.localStorage.setItem(storageKey, content),
        emitChange: () => {
          for (const handler of [...changeHandlers]) handler({ path: boardPath, eventType: 'change', mtimeMs: Date.now() })
        },
        writes: 0,
        lastWriteAt: null as number | null,
        failWrites: null as string | null,
      }
      stateWindow.__KITION_WHITEBOARD_E2E_FILE__ = file
      const registry = () => ({ vaults: [vault], active_vault_path: vaultPath })
      const list = () => ({
        root_path: vaultPath,
        items: [{
          type: 'file' as const,
          path: boardPath,
          name: boardPath,
          format: 'board' as const,
          size: (window.localStorage.getItem(storageKey) || '').length,
          updated_at: updatedAt,
        }],
      })

      stateWindow.kitionDesktop = {
        shell: 'tauri',
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
          const content = await readContent()
          return {
            path: request.path,
            name: request.path.split('/').pop() || request.path,
            content,
            format: 'board',
            updated_at: updatedAt,
            size: content.length,
          }
        },
        // Guarded like the desktop runtime: a write expecting other contents than the file holds is refused.
        WriteWorkspaceDocument: async (request: { path: string; content: string; expected_content?: string | null }) => {
          file.writes += 1
          if (file.failWrites !== null) throw new Error(file.failWrites)
          if (typeof request.expected_content === 'string' && file.read() !== request.expected_content) {
            throw new Error('DESIGN_SAVE_CONFLICT')
          }
          window.localStorage.setItem(storageKey, request.content)
          file.lastWriteAt = performance.now()
          return {
            path: request.path,
            name: request.path.split('/').pop() || request.path,
            content: request.content,
            format: 'board',
            updated_at: updatedAt,
            size: request.content.length,
          }
        },
        documentExternalChangeEvent: externalChangeEvent,
        EventsOn: (name: string, handler: (payload: { path: string; eventType: string; mtimeMs: number }) => void) => {
          if (name !== externalChangeEvent) return () => {}
          changeHandlers.add(handler)
          return () => {
            changeHandlers.delete(handler)
          }
        },
        ImportWorkspaceFile: async (request: { folder?: string; filename: string }) => ({
          imported_path: `${String(request.folder || '').replace(/^\/+|\/+$/g, '')}/${request.filename}`
            .replace(/^\//, ''),
        }),
      }
    },
    {
      boardFileModule: BOARD_FILE_MODULE,
      boardPath: WHITEBOARD_E2E_PATH,
      boardRecords: records,
      boardTitle: BOARD_TITLE,
      externalChangeEvent: EXTERNAL_CHANGE_EVENT,
      initialContent: fileContent,
      kdmModule: KDM_MODULE,
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
