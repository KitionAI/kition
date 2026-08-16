   
                                           
  
                                             
  
                                                             
                                                                          
                                                                 
                                                            
                                      
  
                                                         
                                   
  
                                                          
                         
   
import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-heading-jitter-vault'
const DOC_PATH = 'jitter.md'

                                                         
                                           
const DOC_CONTENT = [
  '# Untitled note 2',
  '',
  'Platform: Knowledge page',
  'Status: draft',
  'Tags:',
  '',
  '## Intro',
  '',
  '',
  '## Body',
  '',
  '',
  '## Publish checklist',
  '',
  '- Title',
  '- Cover',
  '- Tags',
].join('\n')

async function mockDesktop(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, docContent }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>([
        [docPath, { content: docContent, updated_at: '2026-06-07T00:00:00.000Z' }],
      ])
      const vault = {
        path: vaultPath,
        name: 'Jitter Vault',
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
          installation_id: 'jitter-test-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'jitter-test-installation',
            diagnostics: {
              code: '', title: '', message: '', detail: '',
              support_id: '', retryable: false, next_action: '',
            },
          },
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
          const r = docs.get(req.path)
          if (!r) throw new Error('not found')
          return {
            path: req.path,
            name: req.path.split('/').pop() || req.path,
            content: r.content,
            format: 'markdown',
            updated_at: r.updated_at,
            size: r.content.length,
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
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, docContent: DOC_CONTENT },
  )

  await page.addInitScript(({ docPath }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', docPath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
  }, { docPath: DOC_PATH })
}

                                               
                                                         
async function measureHeadingRect(page: Page, needle: string) {
  return await page.evaluate((needleArg) => {
    const lines = Array.from(document.querySelectorAll('.cm-content .cm-line')) as HTMLElement[]
    const line = lines.find((l) => l.textContent?.includes(needleArg)) || null
    if (!line) return null
    const lineRect = line.getBoundingClientRect()

    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let node: Node | null = walker.nextNode()
    let charTop: number | null = null
    while (node) {
      const t = node.nodeValue || ''
      const idx = t.indexOf(needleArg[0])
      if (idx >= 0) {
        const range = document.createRange()
        range.setStart(node, idx)
        range.setEnd(node, idx + 1)
        charTop = range.getBoundingClientRect().top
        break
      }
      node = walker.nextNode()
    }

    return { lineTop: lineRect.top, charTop }
  }, needle)
}

test('typing under a heading does not jitter the heading line', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  await page.waitForSelector('.cm-content .cm-line', { timeout: 10_000 })
             
  await page.waitForTimeout(500)

                                                                          
                                                                      
                                                             
  await page.locator('.cm-content .cm-line', { hasText: 'Intro' }).first().click()
                      
  await page.keyboard.press('ArrowDown')
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
  await page.waitForTimeout(50)

  const initial = await measureHeadingRect(page, 'Intro')
  expect(initial, 'should find Intro heading line').not.toBeNull()
  expect(initial!.charTop, 'should find first char rect of Intro').not.toBeNull()

  const samples: Array<{ lineTop: number; charTop: number | null }> = [initial!]

  for (let i = 0; i < 5; i++) {
    await page.keyboard.type('3')
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
    const m = await measureHeadingRect(page, 'Intro')
    expect(m, `keystroke ${i + 1}: heading line should still exist`).not.toBeNull()
    samples.push(m!)
  }

                                                                     
  const lineTops = samples.map((s) => s.lineTop)
  const charTops = samples.map((s) => s.charTop!)
  const lineRange = Math.max(...lineTops) - Math.min(...lineTops)
  const charRange = Math.max(...charTops) - Math.min(...charTops)
  expect(lineRange, 'The Intro heading top must remain stable between keystrokes').toBeLessThan(0.5)
  expect(charRange, 'The first Intro character must remain stable between keystrokes').toBeLessThan(0.5)
})
