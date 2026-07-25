import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

   
                                    
  
                                                                         
                                                         
  
                                                                        
                          
  
                                                                  
                                                      
                                       
   

const VAULT_PATH = '/tmp/kition-e2e-vault'
const DOC_PATH = 'table-caret.md'

async function mockDesktopBridge(page: Page, md: string) {
  await page.addInitScript(
    ({ vaultPath, docPath, content }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>()
      docs.set(docPath, { content, updated_at: new Date().toISOString() })
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
      const vault = { path: vaultPath, name: 'E2E Vault', added_at: '2026-01-01T00:00:00.000Z', last_opened_at: '2026-01-01T00:00:00.000Z' }
      function makeRegistry() { return { vaults: [vault], active_vault_path: vaultPath } }
      stateWindow.kitionDesktop = {
        shell: 'electron',
        DesktopInfo: async () => ({ is_desktop: true, platform: 'darwin', backend_base_url: 'http://127.0.0.1:18101/api', data_dir: '/tmp/kition/data', cache_dir: '/tmp/kition/cache', logs_dir: '/tmp/kition/logs', uploads_dir: '/tmp/kition/uploads', exports_dir: '/tmp/kition/exports', workspace_dir: vaultPath, supports_secure_storage: true }),
        StoreSecureValue: async (k: string, v: string) => { secureStore.set(k, v) },
        ReadSecureValue: async (k: string) => secureStore.get(k) || '',
        DeleteSecureValue: async (k: string) => { secureStore.delete(k) },
        OpenExternalURL: async () => {},
        ListVaults: async () => makeRegistry(),
        AddVault: async () => ({ vault, registry: makeRegistry() }),
        RemoveVault: async () => makeRegistry(),
        RenameVault: async () => ({ vault, registry: makeRegistry() }),
        SetActiveVault: async () => ({ list: makeListResponse(), registry: makeRegistry() }),
        ListWorkspaceDocuments: async () => makeListResponse(),
        ReadWorkspaceDocument: async (req: { path: string }) => {
          const record = docs.get(req.path)
          if (!record) throw new Error(`document not found: ${req.path}`)
          return { path: req.path, name: req.path.split('/').pop() || req.path, content: record.content, format: 'markdown', updated_at: record.updated_at, size: record.content.length }
        },
        WriteWorkspaceDocument: async (req: { path: string; content: string }) => {
          const updated_at = new Date().toISOString()
          docs.set(req.path, { content: req.content, updated_at })
          return { path: req.path, name: req.path.split('/').pop() || req.path, content: req.content, format: 'markdown', updated_at, size: req.content.length }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, content: md },
  )
  await page.addInitScript(() => {
    window.localStorage.removeItem('kition.document.last-active-path.v1')
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  })
}

test('cursor at a table block boundary does not draw a full-table-height caret', async ({ page }) => {
  const md = ['# Heading', '', 'Some paragraph text here.', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'Trailing paragraph.', ''].join('\n')
  await mockDesktopBridge(page, md)
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.cm-table-widget table')).toBeVisible({ timeout: 10_000 })

  const probe = await page.evaluate(() => {
    const content = document.querySelector('.cm-editor .cm-content') as any
    const view = content?.cmTile?.root?.view
    if (!view) return { hasView: false as const }
    const doc: string = view.state.doc.toString()
    const tableFrom = doc.indexOf('| A | B |')
    const tableTo = doc.indexOf('| 1 | 2 |') + '| 1 | 2 |'.length
    const tableHeight = (view.dom.querySelector('.cm-table-widget') as HTMLElement | null)?.getBoundingClientRect().height ?? 0
    view.focus()
    const caretH = () => {
      const c = view.dom.querySelector('.cm-cursor') as HTMLElement | null
      return c ? c.getBoundingClientRect().height : null
    }
    // Move rightward from just before the table: must skip over the whole block, never rest on it.
    view.dispatch({ selection: { anchor: tableFrom - 1 } })
    view.dispatch({ selection: view.moveByChar(view.state.selection.main, true) })
    const afterRight = { pos: view.state.selection.main.head, caretH: caretH() }
    // Move leftward from just after the table.
    view.dispatch({ selection: { anchor: tableTo + 1 } })
    view.dispatch({ selection: view.moveByChar(view.state.selection.main, false) })
    const afterLeft = { pos: view.state.selection.main.head, caretH: caretH() }
    return { hasView: true as const, tableFrom, tableTo, tableHeight, afterRight, afterLeft }
  })

  if (!probe.hasView) throw new Error('EditorView not reachable in page')

  // The table block is tall (multi-row); the caret must NOT match that height.
  expect(probe.tableHeight).toBeGreaterThan(50)
  // moveByChar must not land the cursor on the block boundary offsets.
  expect(probe.afterRight.pos).not.toBe(probe.tableFrom)
  expect(probe.afterRight.pos).not.toBe(probe.tableTo)
  expect(probe.afterLeft.pos).not.toBe(probe.tableFrom)
  expect(probe.afterLeft.pos).not.toBe(probe.tableTo)
  // Caret height stays at normal line height (well below the full table height).
  expect(probe.afterRight.caretH).toBeLessThan(50)
  expect(probe.afterLeft.caretH).toBeLessThan(50)
})
