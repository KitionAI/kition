import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

const VAULT_PATH = '/tmp/kition-title-edit-vault'
const DOC_PATH = 'original.md'
const IMAGE_NAME = 'Pasted image 20260718005317.png'
const DOC_CONTENT = `# Heading\n\n![[Attachments/${IMAGE_NAME}]]\n\nbody after image`
const IMAGE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#252525"/><rect x="36" y="32" width="568" height="296" rx="16" fill="#343434"/><path d="M80 270 210 142l88 82 82-70 180 116" fill="none" stroke="#9b7cff" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/><circle cx="470" cy="112" r="42" fill="#63d7b0"/></svg>'

async function mockDesktop(page: Page) {
  await page.addInitScript(
    ({ vaultPath, docPath, docContent }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const documentsStorageKey = 'kition.e2e.title-edit.documents'
      const initialDocuments: Array<[string, { content: string; updated_at: string }]> = [
        ['alpha.md', { content: 'Alpha body', updated_at: '2026-06-18T00:00:00.000Z' }],
        [docPath, { content: docContent, updated_at: '2026-06-19T00:00:00.000Z' }],
        ['zulu.md', { content: 'Zulu body', updated_at: '2026-06-20T00:00:00.000Z' }],
      ]
      const storedDocuments = window.localStorage.getItem(documentsStorageKey)
      const docs = new Map<string, { content: string; updated_at: string }>(
        storedDocuments ? JSON.parse(storedDocuments) : initialDocuments,
      )
      const persistDocuments = () => {
        window.localStorage.setItem(documentsStorageKey, JSON.stringify(Array.from(docs.entries())))
      }
      persistDocuments()
      const vault = { path: vaultPath, name: 'Edit Vault', added_at: '2026-06-19T00:00:00.000Z', last_opened_at: '2026-06-19T00:00:00.000Z' }
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
          is_desktop: true, platform: 'darwin', backend_base_url: 'http://127.0.0.1:18101/api',
          data_dir: '/tmp/kition/data', cache_dir: '/tmp/kition/cache', logs_dir: '/tmp/kition/logs',
          uploads_dir: '/tmp/kition/uploads', exports_dir: '/tmp/kition/exports',
          workspace_dir: vaultPath, supports_secure_storage: true,
        }),
        BootstrapInitialize: async () => ({
          installation_id: 'edit-test',
          status: { official_build: false, build_channel: 'community', available: false, state: 'ready', installation_id: 'edit-test',
            diagnostics: { code: '', title: '', message: '', detail: '', support_id: '', retryable: false, next_action: '' } },
        }),
        StoreSecureValue: async () => {}, ReadSecureValue: async () => '', DeleteSecureValue: async () => {},
        OpenExternalURL: async () => {}, OpenRuntimePath: async () => {},
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
          persistDocuments()
          return { path: req.path, name: req.path.split('/').pop()!, content: req.content, format: 'markdown', updated_at, size: req.content.length }
        },
        MoveWorkspaceDocument: async (req: { path: string; target_folder?: string; target_name?: string }) => {
          const existing = docs.get(req.path)!
          const folder = req.target_folder !== undefined ? req.target_folder : (req.path.includes('/') ? req.path.slice(0, req.path.lastIndexOf('/')) : '')
          const name = req.target_name || (req.path.split('/').pop() || req.path)
          const newPath = folder ? `${folder}/${name}` : name
          const updated_at = new Date().toISOString()
          docs.delete(req.path)
          docs.set(newPath, { content: existing?.content ?? '', updated_at })
          persistDocuments()
          return { path: newPath, name, content: existing?.content ?? '', format: 'markdown', updated_at, size: existing?.content.length ?? 0 }
        },
      }
    },
    { vaultPath: VAULT_PATH, docPath: DOC_PATH, docContent: DOC_CONTENT },
  )
  await page.addInitScript(({ docPath }) => {
    window.localStorage.setItem('kition.document.last-active-path.v1', docPath)
    window.localStorage.removeItem('kition.document.workspace-tabs.v1')
  }, { docPath: DOC_PATH })
}

async function mockImageAsset(page: Page) {
  await page.route('**/workspace-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: IMAGE_SVG,
    })
  })
}

async function readDocumentTreeOrder(page: Page, labels: string[]) {
  return page.locator('[data-testid="document-tree"] .document-tree-row').evaluateAll(
    (rows, expectedLabels) => rows
      .map((row) => row.textContent?.trim() || '')
      .filter((label) => expectedLabels.includes(label)),
    labels,
  )
}

test('click title → type → Enter commits and moves focus to cm-content', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')
  const title = page.locator('[data-testid="workspace-document-inline-title"]')
  await title.waitFor({ timeout: 10_000 })

  await title.click()
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="workspace-document-inline-title"]') as HTMLElement
    el.textContent = 'renamed-via-enter'
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.keyboard.press('Enter')

  await expect(title).toHaveText('renamed-via-enter')
  await expect(page.locator('.document-tree-row.is-active')).toContainText('renamed-via-enter.md')
  const focused = await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))
  expect(focused).toBe(true)
})

test('clicking the document body commits the title without rolling back the tree label', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')
  const title = page.locator('[data-testid="workspace-document-inline-title"]')
  await title.waitFor({ timeout: 10_000 })

  await title.click()
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="workspace-document-inline-title"]') as HTMLElement
    el.textContent = 'renamed-via-blur'
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.locator('.document-editor .cm-content').click()

  await expect(title).toHaveText('renamed-via-blur')
  await expect(page.locator('.document-tree-row.is-active')).toContainText('renamed-via-blur.md')
})

test('renaming a document preserves its visible tree position after reload', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')
  const title = page.locator('[data-testid="workspace-document-inline-title"]')
  await title.waitFor({ timeout: 10_000 })

  await expect.poll(() => readDocumentTreeOrder(page, [
    'alpha.md',
    'original.md',
    'zulu.md',
  ])).toEqual(['alpha.md', 'original.md', 'zulu.md'])

  await title.click()
  await page.evaluate(() => {
    const element = document.querySelector('[data-testid="workspace-document-inline-title"]') as HTMLElement
    element.textContent = 'aardvark'
    element.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.keyboard.press('Enter')

  await expect.poll(() => readDocumentTreeOrder(page, [
    'alpha.md',
    'aardvark.md',
    'zulu.md',
  ])).toEqual(['alpha.md', 'aardvark.md', 'zulu.md'])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('document-tree')).toBeVisible()
  await expect.poll(() => readDocumentTreeOrder(page, [
    'alpha.md',
    'aardvark.md',
    'zulu.md',
  ])).toEqual(['alpha.md', 'aardvark.md', 'zulu.md'])
})

test('IME Enter in the title does not move composition text into the document body', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')
  const title = page.locator('[data-testid="workspace-document-inline-title"]')
  const editorContent = page.locator('.document-editor .cm-content')
  await title.waitFor({ timeout: 10_000 })

  const composedTitle = String.fromCodePoint(0x4e2d, 0x6587)
  await title.click()
  await title.evaluate((element, nextTitle) => {
    const titleElement = element as HTMLElement
    titleElement.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    titleElement.textContent = nextTitle
    titleElement.dispatchEvent(new InputEvent('input', { bubbles: true }))
    titleElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
      keyCode: 229,
    }))
    titleElement.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  }, composedTitle)

  await expect(title).toHaveText(composedTitle)
  await expect(editorContent).toContainText('body after image')
  await expect(editorContent).not.toContainText(composedTitle)
  await expect(title).toBeFocused()
})

test('Escape restores the previous title without committing', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')
  const title = page.locator('[data-testid="workspace-document-inline-title"]')
  await title.waitFor({ timeout: 10_000 })

  await title.click()
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="workspace-document-inline-title"]') as HTMLElement
    el.textContent = 'temp-then-bail'
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
  })
  await page.keyboard.press('Escape')

  await expect(title).toHaveText('original')
})

test('pasted image stays rendered beside the cursor and while its source is open', async ({ page }, testInfo) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktop(page)
  await mockImageAsset(page)
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.goto('/document')

  const image = page.locator('.cm-md-image img')
  const imageWrap = page.locator('.cm-md-image')
  const sourceToggle = page.locator('.cm-md-image-source-toggle')
  await expect(image).toBeVisible({ timeout: 10_000 })

  const bodyLine = page.locator('.cm-line', { hasText: 'body after image' })
  await bodyLine.click()
  await expect(image).toBeVisible()
  await expect(page.locator('.cm-md-image-src')).toHaveCount(0)

  await imageWrap.hover()
  await expect(sourceToggle).toHaveCSS('opacity', '1')
  await sourceToggle.click()

  await expect(page.locator('.cm-md-image-src')).toContainText(IMAGE_NAME)
  await expect(image).toBeVisible()
  await expect(sourceToggle).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cm-wikilink-preview')).toHaveCount(0)
  await expect.poll(() => page.locator('.cm-md-image-src, .cm-md-image-src *').evaluateAll((nodes) => {
    const colors = nodes.map((node) => getComputedStyle(node).color)
    return nodes.length > 0
      && colors.every((color) => color === colors[0])
      && nodes.every((node) => getComputedStyle(node).textDecorationLine === 'none')
  })).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('image-source-visible.png') })
})
