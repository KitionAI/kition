/**
 * Mounts the workspace with an in-memory desktop bridge that serves one
 * Markdown document (plus optional extra documents), so editor specs can
 * run against the real renderer without the Electron shell or the runtime.
 */
import type { Page } from '@playwright/test'

const VAULT_PATH = '/tmp/kition-e2e-vault'
export const DEFAULT_DOC_PATH = 'table-test.md'

export async function mockDesktopBridge(
  page: Page,
  tableMarkdown: string,
  additionalDocuments: Record<string, string> = {},
  documentPath: string = DEFAULT_DOC_PATH,
  options: { secureValues?: Record<string, string> } = {},
) {
  await page.addInitScript(
    ({ vaultPath, docPath, content, extraDocuments, secureValues }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>(Object.entries(secureValues))
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content, updated_at: new Date().toISOString() })
      for (const [path, documentContent] of Object.entries(extraDocuments)) {
        docs.set(path, { content: documentContent, updated_at: new Date().toISOString() })
      }

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
    {
      vaultPath: VAULT_PATH,
      docPath: documentPath,
      content: tableMarkdown,
      extraDocuments: additionalDocuments,
      secureValues: options.secureValues ?? {},
    },
  )

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
