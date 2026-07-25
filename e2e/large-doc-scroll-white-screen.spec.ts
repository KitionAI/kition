/**
 * Regression test for the "scrolling a long doc → white screen" bug.
 *
 * Root cause (now fixed):
 *  - styles.css used to set `.document-editor .cm-content { padding-top: 0 !important }`
 *    so that a JS-prepended `.document-editor-title-slot` could sit above cm-content
 *    inside `.cm-scroller` (CM6 has no `.cm-sizer` to host an inline title).
 *  - CM6 windows lines by setting `style.padding-top = "<offset>px"` inline on
 *    cm-content. The `!important` rule beat that → paddingTop always 0 → visible
 *    lines always rendered at y=0 of cm-content, no matter how far the user scrolled.
 *  - With a doc tall enough to trigger windowing (~few hundred lines), scrolling
 *    a few thousand px down left the viewport showing the empty area below
 *    cm-content's actual rendered region → white screen.
 *
 * This test loads a long synthetic markdown doc and scrolls the editor 4000px;
 * after scrolling, at least one `.cm-line` must be visually inside the viewport.
 */
import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

/**
 * Count how many `.cm-line` elements inside `.cm-content` visually intersect
 * the scroller's bounding rect on the y-axis. Uses the same geometry used in
 * the first regression test so both tests share a single definition.
 */
async function linesInViewportCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    if (!scroller) throw new Error('.document-editor .cm-scroller not found')
    const cmContent = document.querySelector('.cm-content') as HTMLElement | null
    if (!cmContent) throw new Error('.cm-content not found')
    const sRect = scroller.getBoundingClientRect()
    const lines = Array.from(cmContent.querySelectorAll('.cm-line')) as HTMLElement[]
    return lines.filter((l) => {
      const r = l.getBoundingClientRect()
      return r.bottom > sRect.top && r.top < sRect.bottom
    }).length
  })
}

const VAULT_PATH = '/tmp/kition-whitescreen-vault'
const DOC_PATH = 'long-article.md'

function buildLongDoc(): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('title: Long document scrolling regression')
  lines.push('tags: [test, regression]')
  lines.push('---')
  lines.push('')
  lines.push('# Long document scrolling regression')
  lines.push('')
  for (let section = 1; section <= 30; section++) {
    lines.push(`## Section ${section}`)
    lines.push('')
    for (let p = 1; p <= 12; p++) {
      lines.push(
        `This is paragraph ${p} in section ${section}. CodeMirror 6 viewport windowing needs enough content to activate. Heavy decorations combined with a forced \`padding-top\` previously caused a blank viewport near the middle of the document.`,
      )
      lines.push('')
    }
    if (section % 3 === 0) {
      lines.push('```ts')
      lines.push(`// Example code for section ${section}`)
      lines.push('export function noop() {}')
      lines.push('```')
      lines.push('')
    }
    if (section % 4 === 0) {
      lines.push(`- Section ${section} list item 1`)
      lines.push(`- Section ${section} list item 2`)
      lines.push(`- Section ${section} list item 3`)
      lines.push('')
    }
  }
  return lines.join('\n')
}

async function mockDesktop(page: Page, docContent: string) {
  await page.addInitScript(
    ({ vaultPath, docPath, content }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
      const docs = new Map<string, { content: string; updated_at: string }>([
        [docPath, { content, updated_at: '2026-06-11T00:00:00.000Z' }],
      ])
      const vault = {
        path: vaultPath,
        name: 'Whitescreen Vault',
        added_at: '2026-06-11T00:00:00.000Z',
        last_opened_at: '2026-06-11T00:00:00.000Z',
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
          installation_id: 'whitescreen-test-installation',
          status: {
            official_build: false,
            build_channel: 'community',
            available: false,
            state: 'ready',
            installation_id: 'whitescreen-test-installation',
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
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, content: docContent },
  )

  await page.addInitScript(({ docPath }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', docPath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
    window.localStorage.removeItem('kition.document.tree.metadata.v1')
    window.localStorage.setItem('kition.document.layout.sideOpen', '0')
    window.localStorage.setItem('kition.document.layout.sideTab', 'outline')
  }, { docPath: DOC_PATH })
}

test('scrolling a long doc keeps content in viewport (no white screen)', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page, buildLongDoc())
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  await page.waitForSelector('.cm-content', { timeout: 10_000 })
  await page.waitForSelector('.cm-line', { timeout: 10_000 })
  await page.waitForTimeout(500)

  const beforeScroll = await page.evaluate(() => {
    const scroller = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
    }
  })

  // Need a tall doc for windowing to matter.
  expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight * 4)

  // Scroll roughly to the middle.
  const targetScrollTop = Math.floor(beforeScroll.scrollHeight * 0.4)
  await page.evaluate((y) => {
    const scroller = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    if (scroller) scroller.scrollTop = y
  }, targetScrollTop)

  // Let CM6 measure + apply layout.
  await page.waitForTimeout(400)

  const afterScroll = await page.evaluate(() => {
    const scroller = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    const cmContent = document.querySelector('.cm-content') as HTMLElement | null
    if (!scroller || !cmContent) return null
    const sRect = scroller.getBoundingClientRect()
    const cRect = cmContent.getBoundingClientRect()
    return {
      scrollTop: scroller.scrollTop,
      scrollerTop: Math.round(sRect.top),
      scrollerBottom: Math.round(sRect.bottom),
      contentTop: Math.round(cRect.top),
      contentBottom: Math.round(cRect.bottom),
      contentPaddingTop: window.getComputedStyle(cmContent).paddingTop,
    }
  })

  expect(afterScroll).not.toBeNull()
  // The regression: cm-content gets stuck at y=0 of cm-content (its bottom ends
  // up above the visible viewport). When fixed, CM6 sets a non-zero paddingTop
  // so the visible window lands inside the scroller's clientRect.
  const midCount = await linesInViewportCount(page)
  expect(midCount).toBeGreaterThan(0)
  expect(afterScroll!.contentBottom).toBeGreaterThan(afterScroll!.scrollerTop)
  expect(afterScroll!.contentTop).toBeLessThan(afterScroll!.scrollerBottom)
})

test('large doc: scroll to bottom and back keeps cm-line viewport populated (sizer regression)', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page, buildLongDoc())
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  await page.waitForSelector('.cm-content', { timeout: 10_000 })
  await page.waitForSelector('.cm-sizer', { timeout: 10_000 })
  await page.waitForSelector('.cm-line', { timeout: 10_000 })
  await page.waitForTimeout(500)

  // Scroll all the way to the bottom.
  await page.evaluate(() => {
    const s = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    if (!s) throw new Error('.document-editor .cm-scroller not found')
    s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(400)

  // At least 5 lines must geometrically intersect the viewport — this rules out
  // CM6 windowing collapses where only a stale stub line remains visible.
  const countAtBottom = await linesInViewportCount(page)
  expect(countAtBottom).toBeGreaterThan(5)

  // Scroll back to the top.
  await page.evaluate(() => {
    const s = document.querySelector('.document-editor .cm-scroller') as HTMLElement | null
    if (!s) throw new Error('.document-editor .cm-scroller not found')
    s.scrollTop = 0
  })
  await page.waitForTimeout(400)

  // Same viewport-intersection check at the top.
  const countAtTop = await linesInViewportCount(page)
  expect(countAtTop).toBeGreaterThan(5)
})

test('rapid editor scrolling does not move the desktop viewport', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page, buildLongDoc())
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  const scroller = page.locator('.document-editor .cm-scroller')
  await expect(scroller).toBeVisible()

  const viewportStyles = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell.is-document-route') as HTMLElement | null
    const app = document.querySelector('#app') as HTMLElement | null
    if (!shell || !app) throw new Error('document workspace root not found')
    return {
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
      appOverflow: getComputedStyle(app).overflow,
      shellOverflow: getComputedStyle(shell).overflow,
      shellOverscroll: getComputedStyle(shell).overscrollBehavior,
      shellTop: shell.getBoundingClientRect().top,
      shellHeight: shell.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    }
  })

  expect(viewportStyles).toMatchObject({
    htmlOverflow: 'hidden',
    bodyOverflow: 'hidden',
    appOverflow: 'hidden',
    shellOverflow: 'hidden',
    shellOverscroll: 'none',
    shellTop: 0,
    shellHeight: viewportStyles.viewportHeight,
  })

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const box = await scroller.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  for (let index = 0; index < 4; index += 1) {
    await page.mouse.wheel(0, 1800)
    await page.mouse.wheel(0, -1800)
  }

  const viewportPosition = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell.is-document-route') as HTMLElement | null
    return {
      windowScrollY: window.scrollY,
      htmlScrollTop: document.documentElement.scrollTop,
      bodyScrollTop: document.body.scrollTop,
      shellTop: shell?.getBoundingClientRect().top ?? Number.NaN,
    }
  })

  expect(viewportPosition).toEqual({
    windowScrollY: 0,
    htmlScrollTop: 0,
    bodyScrollTop: 0,
    shellTop: 0,
  })
})
