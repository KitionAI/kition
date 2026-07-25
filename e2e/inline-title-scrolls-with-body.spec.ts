import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-scroll-vault'
const DOC_PATH = 'long-doc.md'
const DOC_CONTENT = ['# Inline Title Doc', '', ...Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`)].join('\n')

async function mockDesktop(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, docContent }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>([
        [docPath, { content: docContent, updated_at: '2026-06-19T00:00:00.000Z' }],
      ])
      const vault = { path: vaultPath, name: 'Scroll Vault', added_at: '2026-06-19T00:00:00.000Z', last_opened_at: '2026-06-19T00:00:00.000Z' }
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
          installation_id: 'scroll-test',
          status: { official_build: false, build_channel: 'community', available: false, state: 'ready', installation_id: 'scroll-test',
            diagnostics: { code: '', title: '', message: '', detail: '', support_id: '', retryable: false, next_action: '' } },
        }),
        StoreSecureValue: async (k: string, v: string) => { secureStore.set(k, v) },
        ReadSecureValue: async (k: string) => secureStore.get(k) || '',
        DeleteSecureValue: async (k: string) => { secureStore.delete(k) },
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
          const r = docs.get(req.path)!
          return { path: req.path, name: req.path.split('/').pop()!, content: r.content, format: 'markdown', updated_at: r.updated_at, size: r.content.length }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return { path: req.path, name: req.path.split('/').pop()!, content: req.content, format: 'markdown', updated_at, size: req.content.length }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, docContent: DOC_CONTENT },
  )
  await page.addInitScript(({ docPath }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', docPath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
    window.localStorage.setItem('kition.document.layout.sideOpen', '0')
    window.localStorage.setItem('kition.document.layout.sideTab', 'outline')
  }, { docPath: DOC_PATH })
}

test('inline title scrolls off the top when body scrolls', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  await page.waitForSelector('.cm-sizer .inline-title', { timeout: 10_000 })
  await page.waitForSelector('.cm-content', { timeout: 10_000 })

  const initialTop = await page.evaluate(() => {
    const el = document.querySelector('.cm-sizer .inline-title') as HTMLElement
    return Math.round(el.getBoundingClientRect().top)
  })
  expect(initialTop).toBeGreaterThan(0)

  await page.evaluate(() => {
    const s = document.querySelector('.cm-scroller') as HTMLElement
    s.scrollTop = 800
  })
  await page.waitForTimeout(150)

  const scrolledTop = await page.evaluate(() => {
    const el = document.querySelector('.cm-sizer .inline-title') as HTMLElement
    return Math.round(el.getBoundingClientRect().top)
  })
  expect(scrolledTop).toBeLessThan(0)

  await page.evaluate(() => {
    const s = document.querySelector('.cm-scroller') as HTMLElement
    s.scrollTop = 0
  })
  await page.waitForTimeout(150)
  const restoredTop = await page.evaluate(() => {
    const el = document.querySelector('.cm-sizer .inline-title') as HTMLElement
    return Math.round(el.getBoundingClientRect().top)
  })
  expect(Math.abs(restoredTop - initialTop)).toBeLessThan(3)
})
