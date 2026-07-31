import { expect, test, type Page } from '@playwright/test'

import { mockLocalWorkspaceApi } from './helpers/mockApi'

   
                                             
  
        
                                                                              
                                                          
                                    
                                                   
                                                       
  
                                                                              
                                                                
                                                              
                                       
   

const VAULT_PATH = '/tmp/kition-e2e-vault'
const DOC_PATH = 'table-test.md'

test.setTimeout(60_000)

async function mockDesktopBridge(
  page: Page,
  tableMarkdown: string,
  additionalDocuments: Record<string, string> = {},
  documentPath: string = DOC_PATH,
) {
  await page.addInitScript(
    ({ vaultPath, docPath, content, extraDocuments }) => {
      const stateWindow = window as typeof window & Record<string, unknown>
      const secureStore = new Map<string, string>()
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

async function waitForTableWidget(page: Page) {
  await expect(page.getByTestId('document-editor')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.cm-table-widget table')).toBeVisible({ timeout: 20_000 })
}

function tableRowsLocator(page: Page) {
  return page.locator('.cm-table-widget table tbody tr')
}

function tableHeaderCellsLocator(page: Page) {
  return page.locator('.cm-table-widget table thead th')
}

test.describe('table widget - internal links', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
  })

  test('renders and opens an internal link from a table cell', async ({ page }) => {
    const sourcePath = 'Getting Started/Welcome.md'
    const targetPath = 'Guides/Linked target.md'
    const resolvedTargetPath = 'Getting Started/Guides/Linked target.md'
    const md = [
      '# Welcome',
      '',
      '| Included document | Pattern |',
      '|---|---|',
      `| [[${targetPath}]] | Clickable internal link |`,
      '',
    ].join('\n')
    await mockDesktopBridge(page, md, {
      [resolvedTargetPath]: '# Linked target\n\nOpened from the table cell.\n',
    }, sourcePath)

    await page.goto('/')
    await waitForTableWidget(page)

    const link = page.locator('.cm-table-widget .table-cell-wikilink').first()
    await expect(link).toHaveText(targetPath)
    await expect(link).toHaveAttribute('role', 'link')

    await link.click()

    await expect(page.getByTestId('document-editor')).toContainText('Opened from the table cell.')
  })

  test('shows a translated message when an internal link is actually missing', async ({ page }) => {
    const md = [
      '# Welcome',
      '',
      '| Included document |',
      '|---|',
      '| [[Missing note.md]] |',
      '',
    ].join('\n')
    await mockDesktopBridge(page, md)

    await page.goto('/')
    await waitForTableWidget(page)
    await page.locator('.cm-table-widget .table-cell-wikilink').first().click()

    await expect(page.getByTestId('confirm-message')).toHaveText(
      'Missing note.md not found. Create a new note?',
    )
    await page.getByTestId('cancel-btn').click()
  })
})

test.describe('table widget — row/col append from + buttons', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
  })

  test('shows only the append control whose edge rail is hovered', async ({ page }) => {
    const md = [
      '# Test',
      '',
      '| Col 1 | Col 2 | Col 3 |',
      '|---|---|---|',
      '| a | b | c |',
      '',
    ].join('\n')
    await mockDesktopBridge(page, md)

    await page.goto('/')
    await waitForTableWidget(page)

    const table = page.locator('.cm-table-widget table').first()
    const rowButton = page.locator('.cm-table-widget .table-row-btn').first()
    const colButton = page.locator('.cm-table-widget .table-col-btn').first()

    await table.hover({ position: { x: 24, y: 24 } })
    await expect(rowButton).toHaveCSS('opacity', '0')
    await expect(colButton).toHaveCSS('opacity', '0')

    await colButton.hover()
    await expect(colButton).toHaveCSS('opacity', '1')
    await expect(rowButton).toHaveCSS('opacity', '0')

    await rowButton.hover()
    await expect(rowButton).toHaveCSS('opacity', '1')
    await expect(colButton).toHaveCSS('opacity', '0')
  })

  test('appendRow turns an all-empty body row into two rows (regression #21)', async ({ page }) => {
    const md = [
      '# Test',
      '',
      '| Col 1 | Col 2 | Col 3 |',
      '|---|---|---|',
      '|  |  |  |',
      '',
    ].join('\n')
    await mockDesktopBridge(page, md)

    await page.goto('/')
    await waitForTableWidget(page)

    const rows = tableRowsLocator(page)
    await expect(rows).toHaveCount(1)

                                                                     
    const rowButton = page.locator('.cm-table-widget .table-row-btn').first()
    await rowButton.hover()
    await rowButton.click()

    await expect(rows).toHaveCount(2)
  })

  test('appendCol adds one cell to header and every body row', async ({ page }) => {
    const md = [
      '# Test',
      '',
      '| Col 1 | Col 2 | Col 3 |',
      '|---|---|---|',
      '| a | b | c |',
      '| d | e | f |',
      '',
    ].join('\n')
    await mockDesktopBridge(page, md)

    await page.goto('/')
    await waitForTableWidget(page)

    const headers = tableHeaderCellsLocator(page)
    await expect(headers).toHaveCount(3)
    const firstRowCells = page.locator('.cm-table-widget table tbody tr').nth(0).locator('td')
    await expect(firstRowCells).toHaveCount(3)

    const colButton = page.locator('.cm-table-widget .table-col-btn').first()
    await colButton.hover()
    await colButton.click()

    await expect(headers).toHaveCount(4)
    await expect(firstRowCells).toHaveCount(4)
    await expect(page.locator('.cm-table-widget table tbody tr').nth(1).locator('td')).toHaveCount(4)
  })

  test('appendRow preserves existing body cell text and appends an empty row at the end', async ({ page }) => {
    const md = [
      '# Test',
      '',
      '| A | B |',
      '|---|---|',
      '| x1 | y1 |',
      '',
    ].join('\n')
    await mockDesktopBridge(page, md)

    await page.goto('/')
    await waitForTableWidget(page)

    const rows = tableRowsLocator(page)
    await expect(rows).toHaveCount(1)
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('x1')
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('y1')

    const rowButton = page.locator('.cm-table-widget .table-row-btn').first()
    await rowButton.hover()
    await rowButton.click()

    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('td').nth(0)).toHaveText('x1')
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('y1')
    await expect(rows.nth(1).locator('td').nth(0)).toHaveText('')
    await expect(rows.nth(1).locator('td').nth(1)).toHaveText('')
  })
})

test('right-click column header opens a vertically laid-out menu', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| Col 1 | Col 2 | Col 3 |\n|---|---|---|\n| a | b | c |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  const firstHeader = page.locator('.cm-table-widget table thead th').nth(0)
  await firstHeader.click({ button: 'right' })

  const menu = page.locator('.cm-table-menu')
  await expect(menu).toBeVisible()

                                              
  const items = menu.locator('.cm-table-menu-item')
  const count = await items.count()
  expect(count).toBeGreaterThan(3)

  const boxes = []
  for (let i = 0; i < count; i++) {
    const box = await items.nth(i).boundingBox()
    if (box) boxes.push(box)
  }
                                                   
  for (let i = 1; i < boxes.length; i++) {
    expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height - 2)
  }
})

test('clicking outside the column menu closes it', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| A | B |\n|---|---|\n| 1 | 2 |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  await page.locator('.cm-table-widget table thead th').nth(0).click({ button: 'right' })
  await expect(page.locator('.cm-table-menu')).toBeVisible()
  await page.mouse.click(10, 10)
  await expect(page.locator('.cm-table-menu')).toHaveCount(0)
})

test('delete column menu item shows warning color', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| A | B |\n|---|---|\n| 1 | 2 |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  await page.locator('.cm-table-widget table thead th').nth(0).click({ button: 'right' })
                                                                
                                                                 
  const delItem = page.locator('.cm-table-menu-item').filter({ hasText: 'Delete column' })
  await expect(delItem).toBeVisible()
  await expect(delItem).toHaveClass(/is-warning/)
})

test('arrow keys navigate column menu items, Enter triggers selected', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  await page.locator('.cm-table-widget table thead th').nth(1).click({ button: 'right' })
  await expect(page.locator('.cm-table-menu')).toBeVisible()

  await expect(page.locator('.cm-table-menu-item.is-selected')).toHaveCount(1)
  await expect(page.locator('.cm-table-menu-item').nth(0)).toHaveClass(/is-selected/)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cm-table-menu-item').nth(2)).toHaveClass(/is-selected/)

  await page.keyboard.press('Enter')
  await expect(page.locator('.cm-table-menu')).toHaveCount(0)
  await expect(page.locator('.cm-table-widget table thead th')).toHaveCount(4)
})

test('ArrowDown stays inside cell when cursor is on first visual line of multi-line cell', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| A | B |\n|---|---|\n| line1 | x |\n| next | y |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  // Open first body cell and type long enough content to force wrap inside the cell
  const cell = page.locator('.cm-table-widget table tbody tr').nth(0).locator('td').nth(0)
  await cell.click()
  await page.keyboard.type('a'.repeat(300))

  // Move caret to the very beginning of the cell's contenteditable using Selection API
  // (cross-platform: macOS's `Home` is unreliable for caret movement in contenteditable;
  // the caret must also be anchored inside a text node — a collapsed range on the
  // contenteditable element itself produces no client rect in Chromium).
  await page.evaluate(() => {
    const inner = document.querySelector(
      '.cm-table-widget table tbody tr td[data-col="0"][data-row="0"] .table-cell-wrapper',
    ) as HTMLElement | null
    if (!inner) return
    inner.focus()
    const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT)
    const textNode = walker.nextNode() as Text | null
    const range = document.createRange()
    if (textNode) {
      range.setStart(textNode, 0)
      range.setEnd(textNode, 0)
    } else {
      range.selectNodeContents(inner)
      range.collapse(true)
    }
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  })

  await page.keyboard.press('ArrowDown')

  // After ArrowDown from first visual line of a multi-line cell, we should still be inside the same cell (row 0, col 0)
  const stillSameCell = await page.evaluate(() => {
    const ae = document.activeElement as HTMLElement | null
    if (!ae) return false
    const td = ae.closest('td') as HTMLElement | null
    const tr = ae.closest('tr') as HTMLElement | null
    return td?.dataset?.col === '0' && tr?.dataset?.row === '0'
  })
  expect(stillSameCell).toBe(true)
})

test('column align menu items apply text-align to all cells in column', async ({ page }) => {
  await mockDesktopBridge(
    page,
    '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n',
  )
  await mockLocalWorkspaceApi(page)
  await page.goto('/')
  await waitForTableWidget(page)

  await page.locator('.cm-table-widget table thead th').nth(1).click({ button: 'right' })
  const centerItem = page.locator('.cm-table-menu-item').filter({ hasText: 'Align center' })
  await expect(centerItem).toBeVisible()
  await centerItem.dispatchEvent('mousedown')

  // After dispatch, the column 1 cells (header + 2 body rows) should have text-align: center
  await expect(page.locator('.cm-table-widget table thead th').nth(1)).toHaveCSS('text-align', 'center')
  await expect(page.locator('.cm-table-widget table tbody tr').nth(0).locator('td').nth(1)).toHaveCSS('text-align', 'center')
  await expect(page.locator('.cm-table-widget table tbody tr').nth(1).locator('td').nth(1)).toHaveCSS('text-align', 'center')
})

test.describe('table widget - Ctrl+Z reverts structural table actions', () => {
  test.beforeEach(async ({ page }) => {
    await mockLocalWorkspaceApi(page)
  })

  test('Ctrl/Cmd+Z in an idle cell reverts the previous structural table action', async ({ page }) => {
    await mockDesktopBridge(
      page,
      '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n',
    )
    await page.goto('/')
    await waitForTableWidget(page)

    const rows = tableRowsLocator(page)
    await expect(rows).toHaveCount(2)

                                                
    const rowButton = page.locator('.cm-table-widget .table-row-btn').first()
    await rowButton.hover()
    await rowButton.click()
    await expect(rows).toHaveCount(3)

                                                             
    await page.locator('.cm-table-widget table tbody tr').nth(0).locator('.table-cell-wrapper').first().focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(rows).toHaveCount(2)
    await expect(page.locator('.cm-table-widget table tbody tr').nth(1).locator('.table-cell-wrapper').first()).toHaveText('x')
  })
})
