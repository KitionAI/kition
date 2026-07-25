   
                                                        
                                 
  
                                                                            
                                     
  
                                          
                          
   
import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-marker-reveal-vault'
const DOC_PATH = 'marker-reveal.md'

const DOC_CONTENT = [
  '# Verify',
  '',
  'Lead paragraph that sits above the link line.',
  '',
  'Inline link sample: [Kition docs](https://kition.ai) — middle of paragraph.',
  '',
  'Trailing paragraph after the link — used as the click-outside target.',
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
        name: 'Marker Reveal Vault',
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
          installation_id: 'verify-marker-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'verify-marker-installation',
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

async function dumpEditorState(page: Page) {
  return await page.evaluate(() => {
    const link = document.querySelector('.cm-md-link') as HTMLElement | null
    const lines = Array.from(document.querySelectorAll('.cm-content .cm-line')) as HTMLElement[]
    const trailLine = lines.find((l) => l.textContent?.includes('Trailing paragraph'))
    return {
      linkClassList: link ? Array.from(link.classList) : null,
      linkRect: link ? link.getBoundingClientRect() : null,
      trailRect: trailLine ? trailLine.getBoundingClientRect() : null,
    }
  })
}

test('multi-line selection across a markdown link keeps the URL collapsed', async ({ page }, testInfo) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  await page.waitForSelector('.cm-content .cm-line', { timeout: 10_000 })
  await page.waitForTimeout(500)

                                       
  const anchors = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('.cm-content .cm-line')) as HTMLElement[]
    const lead = lines.find((l) => l.textContent?.includes('Lead paragraph'))!
    const linkLine = lines.find((l) => l.textContent?.includes('Kition docs'))!
    const tail = lines.find((l) => l.textContent?.includes('Trailing paragraph'))!
    const r = (el: HTMLElement) => el.getBoundingClientRect()
    return {
      lead: { x: r(lead).left + 20, y: r(lead).top + r(lead).height / 2 },
      linkLine: { x: r(linkLine).left + 20, y: r(linkLine).top + r(linkLine).height / 2 },
                                                                 
      tailX: r(tail).right - 40,
      tailY: r(tail).top + r(tail).height / 2,
    }
  })

                                                                  
  await page.mouse.click(anchors.lead.x, anchors.lead.y)
  await page.waitForTimeout(100)

                                                                   
  await page.mouse.move(anchors.lead.x, anchors.lead.y)
  await page.mouse.down()
  await page.mouse.move(anchors.linkLine.x, anchors.linkLine.y, { steps: 5 })
  await page.mouse.move(anchors.tailX, anchors.tailY, { steps: 5 })
  await page.mouse.up()
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
  await page.waitForTimeout(100)

  const withSelection = await dumpEditorState(page)
  await page.screenshot({ path: testInfo.outputPath('with-selection.png') })

  expect(withSelection.linkRect, 'link should still be in DOM').not.toBeNull()
                                     
  expect(
    withSelection.linkClassList,
    'link should NOT have cm-md-link-expanded while selection spans it',
  ).not.toContain('cm-md-link-expanded')

                                                     
  await page.mouse.click(anchors.lead.x, anchors.lead.y + 1)                             
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
  await page.waitForTimeout(100)

  const afterClickOutside = await dumpEditorState(page)
  await page.screenshot({ path: testInfo.outputPath('after-click-outside.png') })

                                                         
                                  
  const before = withSelection.trailRect!.top
  const after = afterClickOutside.trailRect!.top
  expect(
    Math.abs(after - before),
    `trailing line top should not shift when collapsing the selection (before=${before}, after=${after})`,
  ).toBeLessThan(0.5)

                     
  const linkBefore = withSelection.linkRect!.top
  const linkAfter = afterClickOutside.linkRect!.top
  expect(
    Math.abs(linkAfter - linkBefore),
    `link line top should not shift when collapsing the selection (before=${linkBefore}, after=${linkAfter})`,
  ).toBeLessThan(0.5)
})
