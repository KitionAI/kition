/**
 * Mounts the workspace with an in-memory desktop bridge that serves one
 * Markdown document (plus optional extra documents) and an in-memory document
 * replica store (`./documentStore`), so editor specs can run against the real
 * renderer without the desktop shell or the runtime.
 *
 * The files behave like the desktop shell's: they keep their exact text (CRLF
 * line endings and a byte order mark included) across reloads, a write that
 * expects other contents than the file holds is refused with
 * `DESIGN_SAVE_CONFLICT`, renames move them, and tests can change a file on
 * disk, raise the external-change event the app listens to, count the app's
 * writes, and make them fail (`window.__KITION_MARKDOWN_E2E_FILES__`).
 */
import type { Page } from '@playwright/test'

import { installDocumentStoreBridge, readDocumentStoreState } from './documentStore'

const VAULT_PATH = '/tmp/kition-e2e-vault'
export const DEFAULT_DOC_PATH = 'table-test.md'
/** Where the files are kept between page loads, like a disk. */
const FILES_STORAGE_KEY = 'kition.e2e.markdown.files'
/** The event name the mock desktop bridge raises for a change to a file on disk. */
const EXTERNAL_CHANGE_EVENT = 'kition-e2e:markdown-document-change'

/** The workspace files of the mock desktop bridge, installed in the page before the app loads. */
type MarkdownE2EFiles = {
  /** The file's exact text, or `null` when there is no such file. */
  read: (path: string) => string | null
  /** Replaces (or creates) the file on disk without telling the app (see `emitChange`). */
  write: (path: string, content: string) => void
  /** Raises the desktop bridge's external-change event for `path`. */
  emitChange: (path: string, eventType?: 'add' | 'change' | 'unlink') => void
  /** `WriteWorkspaceDocument` calls per path in this page load, refused ones included. */
  writes: Record<string, number>
  /** `performance.now()` when the last write to each path landed. */
  lastWriteAt: Record<string, number>
  /** When set, every `WriteWorkspaceDocument` call fails with this message (for this page load). */
  failWrites: string | null
}

declare global {
  interface Window {
    __KITION_MARKDOWN_E2E_FILES__?: MarkdownE2EFiles
  }
}

export async function mockDesktopBridge(
  page: Page,
  tableMarkdown: string,
  additionalDocuments: Record<string, string> = {},
  documentPath: string = DEFAULT_DOC_PATH,
  options: { secureValues?: Record<string, string> } = {},
) {
  await page.addInitScript(
    ({ vaultPath, docPath, content, extraDocuments, secureValues, storageKey, externalChangeEvent }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>(Object.entries(secureValues))
      type FileRecord = { content: string; updated_at: string }
      const docs = new Map<string, FileRecord>()
      let stored: Array<[string, FileRecord]> | null = null
      try {
        stored = JSON.parse(window.localStorage.getItem(storageKey) || 'null')
      } catch {
        stored = null
      }
      if (Array.isArray(stored)) {
        for (const [path, record] of stored) docs.set(path, record)
      } else {
        docs.set(docPath, { content, updated_at: new Date().toISOString() })
        for (const [path, documentContent] of Object.entries(extraDocuments)) {
          docs.set(path, { content: documentContent, updated_at: new Date().toISOString() })
        }
      }
      const persist = () => {
        window.localStorage.setItem(storageKey, JSON.stringify(Array.from(docs.entries())))
      }
      persist()

      const changeHandlers = new Set<(payload: { path: string; eventType: string; mtimeMs: number }) => void>()
      const files: MarkdownE2EFiles = {
        read: (path) => docs.get(path)?.content ?? null,
        write: (path, next) => {
          docs.set(path, { content: next, updated_at: new Date().toISOString() })
          persist()
        },
        emitChange: (path, eventType = 'change') => {
          for (const handler of [...changeHandlers]) handler({ path, eventType, mtimeMs: Date.now() })
        },
        writes: {},
        lastWriteAt: {},
        failWrites: null,
      }
      stateWindow.__KITION_MARKDOWN_E2E_FILES__ = files

      const toDocument = (path: string, record: FileRecord) => ({
        path,
        name: path.split('/').pop() || path,
        content: record.content,
        format: 'markdown' as const,
        updated_at: record.updated_at,
        size: record.content.length,
      })

      function makeListResponse() {
        return {
          root_path: vaultPath,
          items: Array.from(docs.keys()).map((path) => ({
            type: 'file' as const,
            path,
            name: path.split('/').pop() || path,
            format: 'markdown' as const,
            size: (docs.get(path)?.content || '').length,
            updated_at: docs.get(path)?.updated_at || '',
          })),
        }
      }

      const vault = {
        path: vaultPath,
        name: 'E2E Vault',
        added_at: '2026-01-01T00:00:00.000Z',
        last_opened_at: '2026-01-01T00:00:00.000Z',
      }

      function makeRegistry() {
        return { vaults: [vault], active_vault_path: vaultPath }
      }

      stateWindow.kitionDesktop = {
        shell: 'tauri',
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
        StoreSecureValue: async (key: string, value: string) => {
          secureStore.set(key, value)
        },
        ReadSecureValue: async (key: string) => secureStore.get(key) || '',
        DeleteSecureValue: async (key: string) => {
          secureStore.delete(key)
        },
        OpenExternalURL: async () => {},

        ListVaults: async () => makeRegistry(),
        AddVault: async () => ({ vault, registry: makeRegistry() }),
        RemoveVault: async () => makeRegistry(),
        RenameVault: async () => ({ vault, registry: makeRegistry() }),
        SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),

        ListWorkspaceDocuments: async () => makeListResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) {
            throw new Error(`document not found: ${req.path}`)
          }
          return toDocument(req.path, record)
        },
        // Guarded like the desktop shell: a write expecting other contents than the file holds is refused.
        WriteWorkspaceDocument: async (req: { path: string; content: string; expected_root?: string; expected_content?: string | null }) => {
          files.writes[req.path] = (files.writes[req.path] ?? 0) + 1
          if (files.failWrites !== null) throw new Error(files.failWrites)
          if (typeof req.expected_root === 'string' && req.expected_root !== vaultPath) throw new Error('DESIGN_WORKSPACE_CHANGED')
          if (typeof req.expected_content === 'string' && files.read(req.path) !== req.expected_content) {
            throw new Error('DESIGN_SAVE_CONFLICT')
          }
          const record = { content: req.content, updated_at: new Date().toISOString() }
          docs.set(req.path, record)
          persist()
          files.lastWriteAt[req.path] = performance.now()
          return toDocument(req.path, record)
        },
        // A rename or move in the tree: the file keeps its exact text at the new path.
        MoveWorkspaceDocument: async (req: { path: string; target_folder?: string; target_name?: string }) => {
          const record = docs.get(req.path)
          if (!record) throw new Error(`document not found: ${req.path}`)
          const slash = req.path.lastIndexOf('/')
          const folder = req.target_folder !== undefined ? req.target_folder : (slash >= 0 ? req.path.slice(0, slash) : '')
          const name = req.target_name || req.path.slice(slash + 1)
          const nextPath = folder ? `${folder}/${name}` : name
          if (nextPath !== req.path && docs.has(nextPath)) throw new Error(`document exists: ${nextPath}`)
          const moved = { content: record.content, updated_at: new Date().toISOString() }
          docs.delete(req.path)
          docs.set(nextPath, moved)
          persist()
          return toDocument(nextPath, moved)
        },
        documentExternalChangeEvent: externalChangeEvent,
        EventsOn: (name: string, handler: (payload: { path: string; eventType: string; mtimeMs: number }) => void) => {
          if (name !== externalChangeEvent) return () => {}
          changeHandlers.add(handler)
          return () => {
            changeHandlers.delete(handler)
          }
        },
      }
    },
    {
      vaultPath: VAULT_PATH,
      docPath: documentPath,
      content: tableMarkdown,
      extraDocuments: additionalDocuments,
      secureValues: options.secureValues ?? {},
      storageKey: FILES_STORAGE_KEY,
      externalChangeEvent: EXTERNAL_CHANGE_EVENT,
    },
  )

  await installDocumentStoreBridge(page, { root: VAULT_PATH })

  await page.addInitScript(() => {
    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
      cancelIdleCallback?: (id: number) => void
    }
    // Keep idle work deterministic without suppressing CodeMirror's background
    // parser, which must finish before live-preview table widgets can mount.
    idleWindow.requestIdleCallback = (callback) => window.setTimeout(callback, 0)
    idleWindow.cancelIdleCallback = (id) => window.clearTimeout(id)
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

/** The exact text of the file at `path` on disk, or `null` when there is none. */
export async function readMarkdownFileText(page: Page, path: string = DEFAULT_DOC_PATH) {
  return page.evaluate((target) => {
    const files = window.__KITION_MARKDOWN_E2E_FILES__
    if (!files) throw new Error('The Markdown e2e files are unavailable')
    return files.read(target)
  }, path)
}

/**
 * Another writer's edit: replaces the file at `path` on disk with `content` (exact text), then
 * raises the external-change event the app listens to unless `emit` is `false`.
 */
export async function writeMarkdownFileExternally(page: Page, content: string, options: { path?: string; emit?: boolean } = {}) {
  await page.evaluate(({ path, next, emit }) => {
    const files = window.__KITION_MARKDOWN_E2E_FILES__
    if (!files) throw new Error('The Markdown e2e files are unavailable')
    files.write(path, next)
    if (emit) files.emitChange(path)
  }, { path: options.path ?? DEFAULT_DOC_PATH, next: content, emit: options.emit !== false })
}

/** How many writes the app has made to the file at `path` in this page load, refused ones included. */
export async function countMarkdownFileWrites(page: Page, path: string = DEFAULT_DOC_PATH) {
  return page.evaluate((target) => window.__KITION_MARKDOWN_E2E_FILES__?.writes[target] ?? 0, path)
}

/** `performance.now()` when the app's last write to `path` landed, or `null` before the first. */
export async function readMarkdownFileLastWriteAt(page: Page, path: string = DEFAULT_DOC_PATH) {
  return page.evaluate((target) => window.__KITION_MARKDOWN_E2E_FILES__?.lastWriteAt[target] ?? null, path)
}

/** Makes every later file write fail with `message` (`null` lets writes through). */
export async function failMarkdownFileWrites(page: Page, message: string | null) {
  await page.evaluate((failure) => {
    const files = window.__KITION_MARKDOWN_E2E_FILES__
    if (!files) throw new Error('The Markdown e2e files are unavailable')
    files.failWrites = failure
  }, message)
}

/** The document id the replica store's index gives `path`, or `null` when it has none. */
export async function readDocumentIdOf(page: Page, path: string = DEFAULT_DOC_PATH) {
  return (await readDocumentStoreState(page)).index.entries[path] ?? null
}
