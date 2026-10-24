import { expect, test, type FrameLocator, type Page } from '@playwright/test'

import { lineDiff, noteFrame, noteText, openNote, pressCommand } from './helpers/noteKit'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * The GFM table widget of the Note kit (`kit.note`) in Kition's kit frame: the scenarios of the
 * mandatory table gate (`pnpm test:table:e2e`). Each structural action is also checked in the
 * saved file, which differs from the original only in the lines the action is about. The kit's
 * package is required: without it these fail, never skip.
 */
test.setTimeout(120_000)

type Saved = Array<{ path: string | null; bytes: Buffer }>

/** Opens `text` as the note `name` and waits for its table widget. */
async function openTable(page: Page, baseURL: string, text: string, name = 'Table.md', others: Record<string, Buffer> = {}) {
  const opened = await openNote(page, baseURL, name, text, others)
  await expect(opened.kit.locator('.cm-table-widget table')).toBeVisible({ timeout: 30_000 })
  return opened
}

const rows = (kit: FrameLocator) => kit.locator('.cm-table-widget table tbody tr')
const headers = (kit: FrameLocator) => kit.locator('.cm-table-widget table thead th')

/** Hovers, then clicks one of the append buttons (`table-row-btn`, `table-col-btn`). */
async function append(kit: FrameLocator, kind: 'table-row-btn' | 'table-col-btn') {
  const button = kit.locator(`.cm-table-widget .${kind}`).first()
  await button.hover()
  await button.click()
}

/** Saves the note with the kit's Save and answers the bytes Kition wrote, as text. */
async function save(kit: FrameLocator, saves: Saved) {
  const before = saves.length
  await kit.getByTestId('note-save').click()
  await expect.poll(() => saves.length).toBeGreaterThan(before)
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)
  return saves.at(-1)!.bytes.toString('utf8')
}

test.describe('note table widget - internal links', () => {
  test('renders and opens an internal link from a table cell', async ({ page, baseURL }) => {
    const sourcePath = 'Getting Started/Welcome.md'
    const resolvedTargetPath = 'Getting Started/Guides/Linked target.md'
    const md = ['# Welcome', '', '| Included document | Pattern |', '|---|---|', '| [[Guides/Linked target.md]] | Clickable internal link |', ''].join('\n')
    const { kit } = await openTable(page, baseURL!, md, sourcePath, { [resolvedTargetPath]: Buffer.from('# Linked target\n\nOpened from the table cell.\n') })

    const link = kit.locator('.cm-table-widget .table-cell-wikilink').first()
    await expect(link).toHaveText('Guides/Linked target.md')
    await expect(link).toHaveAttribute('role', 'link')
    // The widget navigates on mousedown; the kit asks Kition to open the note (`host/open`).
    await link.dispatchEvent('mousedown', { button: 0 })

    // The linked note opens in its own tab, in the Note kit.
    await expect.poll(async () => {
      for (const frame of page.frames().filter((candidate) => candidate.url().includes('/kits/note-ui/'))) {
        if ((await frame.locator('.cm-content').textContent().catch(() => ''))?.includes('Opened from the table cell.')) return true
      }
      return false
    }, { timeout: 30_000 }).toBe(true)
  })

  test('offers to create a note an internal link names that does not exist', async ({ page, baseURL }) => {
    const md = ['# Welcome', '', '| Included document |', '|---|', '| [[Missing note.md]] |', ''].join('\n')
    const { kit } = await openTable(page, baseURL!, md)
    await kit.locator('.cm-table-widget .table-cell-wikilink').first().dispatchEvent('mousedown', { button: 0 })
    await expect(kit.getByTestId('note-link-missing-message')).toHaveText('Missing note.md not found. Create a new note?')
    await kit.getByTestId('note-link-cancel').click()
    await expect(kit.getByTestId('note-link-missing-message')).toHaveCount(0)
  })
})

test.describe('note table widget - row and column append from the + buttons', () => {
  test('shows only the append control whose edge rail is hovered', async ({ page, baseURL }) => {
    const { kit } = await openTable(page, baseURL!, ['# Test', '', '| Col 1 | Col 2 | Col 3 |', '|---|---|---|', '| a | b | c |', ''].join('\n'))
    const table = kit.locator('.cm-table-widget table').first()
    const rowButton = kit.locator('.cm-table-widget .table-row-btn').first()
    const colButton = kit.locator('.cm-table-widget .table-col-btn').first()

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

  test('appendRow turns an all-empty body row into two rows (regression #21)', async ({ page, baseURL, browserName }) => {
    const original = ['# Test', '', '| Col 1 | Col 2 | Col 3 |', '|---|---|---|', '|  |  |  |', ''].join('\n')
    const { kit, saves } = await openTable(page, baseURL!, original)
    await expect(rows(kit)).toHaveCount(1)
    await append(kit, 'table-row-btn')
    await expect(rows(kit)).toHaveCount(2)

    const saved = await save(kit, saves)
    if (canReadBlobBodies(browserName)) {
      const diff = lineDiff(original, saved)
      expect(diff.removed).toEqual([])
      expect(diff.added).toHaveLength(1)
      expect(diff.added[0]).toMatch(/^\|.*\|$/)
    }
  })

  test('appendCol adds one cell to the header and every body row', async ({ page, baseURL, browserName }) => {
    const original = ['# Test', '', '| Col 1 | Col 2 | Col 3 |', '|---|---|---|', '| a | b | c |', '| d | e | f |', ''].join('\n')
    const { kit, saves } = await openTable(page, baseURL!, original)
    await expect(headers(kit)).toHaveCount(3)
    await expect(rows(kit).nth(0).locator('td')).toHaveCount(3)

    await append(kit, 'table-col-btn')
    await expect(headers(kit)).toHaveCount(4)
    await expect(rows(kit).nth(0).locator('td')).toHaveCount(4)
    await expect(rows(kit).nth(1).locator('td')).toHaveCount(4)

    const saved = await save(kit, saves)
    if (canReadBlobBodies(browserName)) {
      // Only the table's lines change, each by one cell.
      const diff = lineDiff(original, saved)
      const tableLines = original.split('\n').filter((line) => line.startsWith('|'))
      expect(diff.removed).toEqual(tableLines)
      expect(diff.added).toHaveLength(tableLines.length)
      diff.added.forEach((line, index) => {
        expect(line.startsWith(tableLines[index])).toBe(true)
        expect(line.split('|')).toHaveLength(tableLines[index].split('|').length + 1)
      })
    }
  })

  test('appendRow keeps the body text and appends an empty row at the end', async ({ page, baseURL, browserName }) => {
    const original = ['# Test', '', '| A | B |', '|---|---|', '| x1 | y1 |', ''].join('\n')
    const { kit, saves } = await openTable(page, baseURL!, original)
    await expect(rows(kit)).toHaveCount(1)
    await expect(rows(kit).nth(0).locator('td').nth(0)).toHaveText('x1')
    await expect(rows(kit).nth(0).locator('td').nth(1)).toHaveText('y1')

    await append(kit, 'table-row-btn')
    await expect(rows(kit)).toHaveCount(2)
    await expect(rows(kit).nth(0).locator('td').nth(0)).toHaveText('x1')
    await expect(rows(kit).nth(0).locator('td').nth(1)).toHaveText('y1')
    await expect(rows(kit).nth(1).locator('td').nth(0)).toHaveText('')
    await expect(rows(kit).nth(1).locator('td').nth(1)).toHaveText('')

    const saved = await save(kit, saves)
    if (canReadBlobBodies(browserName)) {
      const diff = lineDiff(original, saved)
      expect(diff.removed).toEqual([])
      expect(diff.added).toHaveLength(1)
      expect(diff.added[0].replace(/\s/g, '')).toBe('|||')
    }
  })
})

test('right-clicking a column header opens a vertically laid-out menu', async ({ page, baseURL }) => {
  const { kit } = await openTable(page, baseURL!, '| Col 1 | Col 2 | Col 3 |\n|---|---|---|\n| a | b | c |\n')
  await headers(kit).nth(0).click({ button: 'right' })
  const menu = kit.locator('.cm-table-menu')
  await expect(menu).toBeVisible()

  const items = menu.locator('.cm-table-menu-item')
  const count = await items.count()
  expect(count).toBeGreaterThan(3)
  const boxes = []
  for (let i = 0; i < count; i++) {
    const box = await items.nth(i).boundingBox()
    if (box) boxes.push(box)
  }
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].height - 2)
})

test('clicking outside the column menu closes it', async ({ page, baseURL }) => {
  const { kit } = await openTable(page, baseURL!, '| A | B |\n|---|---|\n| 1 | 2 |\n')
  await headers(kit).nth(0).click({ button: 'right' })
  await expect(kit.locator('.cm-table-menu')).toBeVisible()
  // On Kition's page, outside the kit's frame.
  await page.mouse.click(10, 10)
  await expect(kit.locator('.cm-table-menu')).toHaveCount(0)
})

test('the Delete column menu item shows the warning colour', async ({ page, baseURL }) => {
  const { kit } = await openTable(page, baseURL!, '| A | B |\n|---|---|\n| 1 | 2 |\n')
  await headers(kit).nth(0).click({ button: 'right' })
  const deleteItem = kit.locator('.cm-table-menu-item').filter({ hasText: 'Delete column' })
  await expect(deleteItem).toBeVisible()
  await expect(deleteItem).toHaveClass(/is-warning/)
})

test('arrow keys move through the column menu items, and Enter runs the selected one', async ({ page, baseURL, browserName }) => {
  const original = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n'
  const { kit, saves } = await openTable(page, baseURL!, original)
  await headers(kit).nth(1).click({ button: 'right' })
  await expect(kit.locator('.cm-table-menu')).toBeVisible()
  await expect(kit.locator('.cm-table-menu-item.is-selected')).toHaveCount(1)
  await expect(kit.locator('.cm-table-menu-item').nth(0)).toHaveClass(/is-selected/)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(kit.locator('.cm-table-menu-item').nth(2)).toHaveClass(/is-selected/)

  await page.keyboard.press('Enter')
  await expect(kit.locator('.cm-table-menu')).toHaveCount(0)
  await expect(headers(kit)).toHaveCount(4)

  const saved = await save(kit, saves)
  if (canReadBlobBodies(browserName)) {
    // Every table line gains one cell; nothing else changes.
    const lines = saved.split('\n')
    expect(lines.slice(0, 3).every((line) => line.split('|').length === 6)).toBe(true)
    expect(lines.slice(3)).toEqual(original.split('\n').slice(3))
  }
})

test('ArrowDown stays inside the cell when the caret is on the first visual line of a wrapped cell', async ({ page, baseURL }) => {
  const { kit } = await openTable(page, baseURL!, '| A | B |\n|---|---|\n| line1 | x |\n| next | y |\n')
  await rows(kit).nth(0).locator('td').nth(0).click()
  await page.keyboard.type('a'.repeat(300))

  // The caret at the very start of the cell's text, through the Selection API (macOS's Home is
  // unreliable in contenteditable, and a collapsed range on the element itself has no rect).
  const frame = await noteFrame(page)
  await frame.evaluate(() => {
    const inner = document.querySelector('.cm-table-widget table tbody tr td[data-col="0"][data-row="0"] .table-cell-wrapper') as HTMLElement | null
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
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })

  await page.keyboard.press('ArrowDown')
  const stillSameCell = await frame.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const cell = active?.closest('td') as HTMLElement | null
    const row = active?.closest('tr') as HTMLElement | null
    return cell?.dataset?.col === '0' && row?.dataset?.row === '0'
  })
  expect(stillSameCell).toBe(true)
})

test('the column align menu items align every cell of the column', async ({ page, baseURL, browserName }) => {
  const original = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n'
  const { kit, saves } = await openTable(page, baseURL!, original)
  await headers(kit).nth(1).click({ button: 'right' })
  const centerItem = kit.locator('.cm-table-menu-item').filter({ hasText: 'Align center' })
  await expect(centerItem).toBeVisible()
  await centerItem.dispatchEvent('mousedown')

  await expect(headers(kit).nth(1)).toHaveCSS('text-align', 'center')
  await expect(rows(kit).nth(0).locator('td').nth(1)).toHaveCSS('text-align', 'center')
  await expect(rows(kit).nth(1).locator('td').nth(1)).toHaveCSS('text-align', 'center')

  const saved = await save(kit, saves)
  if (canReadBlobBodies(browserName)) {
    // Only the delimiter row changes: its second column is centred.
    const diff = lineDiff(original, saved)
    expect(diff.removed).toEqual(['|---|---|---|'])
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0].split('|')[2]).toMatch(/^\s*:-+:\s*$/)
  }
})

test.describe('note table widget - Undo reverts structural table actions', () => {
  test('Undo in an idle cell reverts the previous structural table action', async ({ page, baseURL }) => {
    const { kit } = await openTable(page, baseURL!, '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n')
    await expect(rows(kit)).toHaveCount(2)
    await append(kit, 'table-row-btn')
    await expect(rows(kit)).toHaveCount(3)

    await rows(kit).nth(0).locator('.table-cell-wrapper').first().focus()
    await pressCommand(page, kit, 'z')
    await expect(rows(kit)).toHaveCount(2)
    await expect(rows(kit).nth(1).locator('.table-cell-wrapper').first()).toHaveText('x')
    expect(await noteText(page)).toBe('| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n')
  })
})
