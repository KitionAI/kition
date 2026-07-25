import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-align-vault'
const DOC_PATH = 'untitled-222333333555533555-note-33323333222233.md'

const DOC_CONTENT = [
  '##  Untitled 333',
  '',
  'Workspace: Ideas',
  'Status: Draft',
  'Tags:',
  '',
  '# 1231223',
  '11',
  '3333',
  '## Opening',
  '',
  '## Body',
  '12222',
  '',
  '',
  '## Publishing Checklist**',
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
        name: 'Align Vault',
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
          installation_id: 'align-test-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'align-test-installation',
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
    // Open the document side panel to reproduce the layout the user reports
    window.localStorage.setItem('kition.document.layout.sideOpen', '0')
    window.localStorage.setItem('kition.document.layout.sideTab', 'outline')
  }, { docPath: DOC_PATH })
}

test('title and body x-position alignment in rich mode', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 2400, height: 1400 })
  await page.goto('/document')

  // Wait for the inline title to appear
  await page.waitForSelector('.workspace-document-inline-title', { timeout: 10_000 })
  await page.waitForSelector('.cm-content', { timeout: 10_000 })
  await page.waitForTimeout(500)

  const result = await page.evaluate(() => {
    const titleEl = document.querySelector('.workspace-document-inline-title') as HTMLElement | null
    const titleSlot = document.querySelector('.document-editor-title-slot') as HTMLElement | null
    const cmContent = document.querySelector('.cm-content') as HTMLElement | null
    const documentPane = document.querySelector('.document-editor-pane') as HTMLElement | null

    const scroller = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    const scrollerCS = scroller ? window.getComputedStyle(scroller) : null
    const cmContentCS = cmContent ? window.getComputedStyle(cmContent) : null

    const allLines = Array.from(document.querySelectorAll('.cm-content .cm-line')) as HTMLElement[]
    const firstLine = allLines[0] || null

    const findLineByText = (text: string) =>
      allLines.find((l) => l.textContent?.includes(text)) || null

  const h2Line = findLineByText('Untitled 333')
  const bodyLine = findLineByText('Workspace:')

    // Walk up the DOM and dump every ancestor's box + style to find the offset source
    const ancestorChain = (el: HTMLElement | null) => {
      if (!el) return []
      const chain: Array<Record<string, unknown>> = []
      let cur: HTMLElement | null = el
      while (cur && cur !== document.body) {
        const r = cur.getBoundingClientRect()
        const cs = window.getComputedStyle(cur)
        chain.push({
          tag: cur.tagName.toLowerCase(),
          cls: cur.className || '',
          left: Math.round(r.left),
          width: Math.round(r.width),
          padL: cs.paddingLeft,
          marL: cs.marginLeft,
          maxW: cs.maxWidth,
          display: cs.display,
          flex: cs.flex,
        })
        cur = cur.parentElement
      }
      return chain
    }

    const measureFirstVisibleCharX = (line: HTMLElement | null): number | null => {
      if (!line) return null
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let node: Node | null = walker.nextNode()
      while (node) {
        const t = node.nodeValue || ''
        if (t.trim().length > 0) {
          const range = document.createRange()
          let idx = 0
          while (idx < t.length && /\s/.test(t[idx])) idx++
          if (idx < t.length) {
            range.setStart(node, idx)
            range.setEnd(node, idx + 1)
            const r = range.getBoundingClientRect()
            return r.left
          }
        }
        node = walker.nextNode()
      }
      return null
    }

    return {
      titleSlotCount: document.querySelectorAll('.document-editor-title-slot').length,
      titleElCount: document.querySelectorAll('.workspace-document-inline-title').length,
      cmContentCount: document.querySelectorAll('.cm-content').length,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollerCS: scrollerCS ? {
        flexDirection: scrollerCS.flexDirection,
        alignItems: scrollerCS.alignItems,
      } : null,
      cmContentCS: cmContentCS ? {
        width: cmContentCS.width,
        maxWidth: cmContentCS.maxWidth,
        marginLeft: cmContentCS.marginLeft,
        paddingLeft: cmContentCS.paddingLeft,
      } : null,
      titleVisibleX: measureFirstVisibleCharX(titleEl),
      h2VisibleX: measureFirstVisibleCharX(h2Line),
      bodyVisibleX: measureFirstVisibleCharX(bodyLine),
      titleSlotBox: titleSlot ? { left: Math.round(titleSlot.getBoundingClientRect().left), width: Math.round(titleSlot.getBoundingClientRect().width) } : null,
      cmContentBox: cmContent ? { left: Math.round(cmContent.getBoundingClientRect().left), width: Math.round(cmContent.getBoundingClientRect().width) } : null,
      documentPaneBox: documentPane ? { left: Math.round(documentPane.getBoundingClientRect().left), width: Math.round(documentPane.getBoundingClientRect().width) } : null,
      titleAncestors: ancestorChain(titleEl),
      cmContentAncestors: ancestorChain(cmContent),
    }
  })

  console.log('alignment probe:', JSON.stringify(result, null, 2))
  await page.screenshot({ path: 'e2e/title-body-alignment.png', fullPage: false })

  // The leftmost printed character of the title and of every body line must share the same x.
  // ±1px allowed for CJK sub-pixel rasterization.
  expect(result.titleVisibleX).not.toBeNull()
  expect(result.h2VisibleX).not.toBeNull()
  expect(result.bodyVisibleX).not.toBeNull()
  // Exactly one of each — no stale duplicate from a different mode/portal.
  // (Phase 2 moved the source-view title from .document-editor-title-slot into
  // the .cm-sizer .inline-title portal, so titleSlotCount is now 0 in source view
  // — the reading-view path still uses the slot. titleElCount + cmContentCount
  // together prove the source-view rendering is not duplicated.)
  expect(result.titleElCount).toBe(1)
  expect(result.cmContentCount).toBe(1)
  const delta_h2_vs_title = result.h2VisibleX! - result.titleVisibleX!
  const delta_body_vs_title = result.bodyVisibleX! - result.titleVisibleX!
  expect(Math.abs(delta_h2_vs_title)).toBeLessThan(1)
  expect(Math.abs(delta_body_vs_title)).toBeLessThan(1)
})

test('inline-title host x-position aligns with body inside cm-sizer (phase 1)', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 2400, height: 1400 })
  await page.goto('/document')
  await page.waitForSelector('.cm-sizer .inline-title', { state: 'attached', timeout: 10_000 })
  await page.waitForSelector('.cm-content', { state: 'attached', timeout: 10_000 })
  await page.waitForTimeout(500)

  const result = await page.evaluate(() => {
    const titleHost = document.querySelector('.cm-sizer > .inline-title') as HTMLElement | null
    const cmContent = document.querySelector('.cm-content') as HTMLElement | null
    if (!titleHost || !cmContent) return null
    const t = titleHost.getBoundingClientRect()
    const c = cmContent.getBoundingClientRect()
    return {
      titleLeft: Math.round(t.left),
      titleRight: Math.round(t.right),
      contentLeft: Math.round(c.left),
      contentRight: Math.round(c.right),
    }
  })
  expect(result).not.toBeNull()
  expect(Math.abs(result!.titleLeft - result!.contentLeft)).toBeLessThan(1)
  expect(Math.abs(result!.titleRight - result!.contentRight)).toBeLessThan(1)
})
