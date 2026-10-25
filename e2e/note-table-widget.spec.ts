import { expect, test, type FrameLocator, type Page } from '@playwright/test'

import { caretAfter, lineDiff, noteText, openNote, pressCommand } from './helpers/noteKit'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * The GFM table widget of the Note kit (`kit.note`) in Kition's kit frame: the scenarios of the
 * mandatory table gate (`pnpm test:table:e2e`). The kit's engine draws the table as a grid on its
 * canvas and edits its cells; the editor puts the table controls over it (an append button on each
 * edge rail, the column menu). Each structural action is also checked in the saved file, which
 * differs from the original only in the lines the action is about. The kit's package is required:
 * without it these fail, never skip.
 */
test.setTimeout(120_000)

type Saved = Array<{ path: string | null; bytes: Buffer }>

/** Opens `text` as the note `name` and waits for its table. */
async function openTable(page: Page, baseURL: string, text: string, name = 'Table.md', others: Record<string, Buffer> = {}) {
  const opened = await openNote(page, baseURL, name, text, others)
  await expect(table(opened.kit)).toBeVisible({ timeout: 30_000 })
  return opened
}

const table = (kit: FrameLocator) => kit.getByTestId('note-table').first()
const columns = async (kit: FrameLocator) => Number(await table(kit).getAttribute('data-columns'))
/** Rows with the header. */
const rows = async (kit: FrameLocator) => Number(await table(kit).getAttribute('data-rows'))

/** The page point at the center of cell (`row`, `column`); row 0 is the header. */
async function cell(kit: FrameLocator, row: number, column: number) {
  const box = await table(kit).boundingBox()
  const edges = ((await table(kit).getAttribute('data-column-edges')) ?? '').split(',').map(Number)
  const tops = ((await table(kit).getAttribute('data-row-edges')) ?? '').split(',').map(Number)
  if (!box) throw new Error('the table is not shown')
  return { x: box.x + ((edges[column] ?? 0) + (edges[column + 1] ?? 0)) / 2, y: box.y + ((tops[row] ?? 0) + (tops[row + 1] ?? 0)) / 2 }
}

/** Hovers the edge rail, then clicks its append button. */
async function append(kit: FrameLocator, kind: 'row' | 'col') {
  await kit.getByTestId(`note-table-${kind}-rail`).first().hover()
  await kit.getByTestId(`note-table-${kind}-add`).first().click()
}

/** Opens the column menu with a right click on header cell `column`. */
async function columnMenu(page: Page, kit: FrameLocator, column: number) {
  const at = await cell(kit, 0, column)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await expect(kit.getByTestId('note-table-menu')).toBeVisible()
}

/** Saves the note with the kit's Save and answers the bytes Kition wrote, as text. */
async function save(kit: FrameLocator, saves: Saved) {
  const before = saves.length
  await kit.getByTestId('note-save').click()
  await expect.poll(() => saves.length).toBeGreaterThan(before)
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)
  return saves.at(-1)!.bytes.toString('utf8')
}

/** The note's lines starting with a pipe. */
const tableLines = (text: string) => text.split('\n').filter((line) => line.startsWith('|'))

test.describe('note table widget - internal links', () => {
  test('renders and opens an internal link from a table cell', async ({ page, baseURL }) => {
    const sourcePath = 'Getting Started/Welcome.md'
    const resolvedTargetPath = 'Getting Started/Guides/Linked target.md'
    const md = ['# Welcome', '', '| Included document | Pattern |', '|---|---|', '| [[Guides/Linked target.md]] | Clickable internal link |', ''].join('\n')
    const { kit } = await openTable(page, baseURL!, md, sourcePath, { [resolvedTargetPath]: Buffer.from('# Linked target\n\nOpened from the table cell.\n') })

    // The link is drawn as a link (its brackets hidden); a click asks Kition to open it (`host/open`).
    const at = await cell(kit, 1, 0)
    await page.mouse.click(at.x, at.y)

    // The linked note opens in its own tab, in the Note kit.
    await expect.poll(async () => {
      for (const frame of page.frames().filter((candidate) => candidate.url().includes('/kits/note-ui/'))) {
        if ((await frame.getByTestId('note-text').textContent().catch(() => ''))?.includes('Opened from the table cell.')) return true
      }
      return false
    }, { timeout: 30_000 }).toBe(true)
  })

  test('offers to create a note an internal link names that does not exist', async ({ page, baseURL }) => {
    const md = ['# Welcome', '', '| Included document |', '|---|', '| [[Missing note.md]] |', ''].join('\n')
    const { kit } = await openTable(page, baseURL!, md)
    const at = await cell(kit, 1, 0)
    await page.mouse.click(at.x, at.y)
    await expect(kit.getByTestId('note-link-missing-message')).toHaveText('Missing note.md not found. Create a new note?')
    await kit.getByTestId('note-link-cancel').click()
    await expect(kit.getByTestId('note-link-missing-message')).toHaveCount(0)
  })
})

test.describe('note table widget - row and column append from the + buttons', () => {
  test('shows only the append control whose edge rail is hovered', async ({ page, baseURL }) => {
    const { kit } = await openTable(page, baseURL!, ['# Test', '', '| Col 1 | Col 2 | Col 3 |', '|---|---|---|', '| a | b | c |', ''].join('\n'))
    const rowButton = kit.getByTestId('note-table-row-add').first()
    const colButton = kit.getByTestId('note-table-col-add').first()

    const inside = await cell(kit, 1, 0)
    await page.mouse.move(inside.x, inside.y)
    await expect(rowButton).toHaveCSS('opacity', '0')
    await expect(colButton).toHaveCSS('opacity', '0')

    await kit.getByTestId('note-table-col-rail').first().hover()
    await expect(colButton).toHaveCSS('opacity', '1')
    await expect(rowButton).toHaveCSS('opacity', '0')

    await kit.getByTestId('note-table-row-rail').first().hover()
    await expect(rowButton).toHaveCSS('opacity', '1')
    await expect(colButton).toHaveCSS('opacity', '0')
  })

  test('appendRow turns an all-empty body row into two rows (regression #21)', async ({ page, baseURL, browserName }) => {
    const original = ['# Test', '', '| Col 1 | Col 2 | Col 3 |', '|---|---|---|', '|  |  |  |', ''].join('\n')
    const { kit, saves } = await openTable(page, baseURL!, original)
    expect(await rows(kit)).toBe(2)
    await append(kit, 'row')
    await expect.poll(() => rows(kit)).toBe(3)

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
    expect(await columns(kit)).toBe(3)

    await append(kit, 'col')
    await expect.poll(() => columns(kit)).toBe(4)

    const saved = await save(kit, saves)
    if (canReadBlobBodies(browserName)) {
      // Only the table's lines change, each by one cell.
      const diff = lineDiff(original, saved)
      const lines = tableLines(original)
      expect(diff.removed).toEqual(lines)
      expect(diff.added).toHaveLength(lines.length)
      diff.added.forEach((line, index) => {
        expect(line.startsWith(lines[index])).toBe(true)
        expect(line.split('|')).toHaveLength(lines[index].split('|').length + 1)
      })
    }
  })

  test('appendRow keeps the body text and appends an empty row at the end', async ({ page, baseURL, browserName }) => {
    const original = ['# Test', '', '| A | B |', '|---|---|', '| x1 | y1 |', ''].join('\n')
    const { kit, saves } = await openTable(page, baseURL!, original)
    expect(await rows(kit)).toBe(2)

    await append(kit, 'row')
    await expect.poll(() => rows(kit)).toBe(3)
    await expect.poll(() => noteText(page)).toContain('| x1 | y1 |')

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
  await columnMenu(page, kit, 0)

  const items = kit.getByTestId('note-table-menu-item')
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
  await columnMenu(page, kit, 0)
  // On Kition's page, outside the kit's frame.
  await page.mouse.click(10, 10)
  await expect(kit.getByTestId('note-table-menu')).toHaveCount(0)
})

test('the Delete column menu item shows the warning colour', async ({ page, baseURL }) => {
  const { kit } = await openTable(page, baseURL!, '| A | B |\n|---|---|\n| 1 | 2 |\n')
  await columnMenu(page, kit, 0)
  const deleteItem = kit.getByTestId('note-table-menu-item').filter({ hasText: 'Delete column' })
  await expect(deleteItem).toBeVisible()
  await expect(deleteItem).toHaveClass(/is-warning/)
})

test('arrow keys move through the column menu items, and Enter runs the selected one', async ({ page, baseURL, browserName }) => {
  const original = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n'
  const { kit, saves } = await openTable(page, baseURL!, original)
  await columnMenu(page, kit, 1)
  const items = kit.getByTestId('note-table-menu-item')
  await expect(kit.locator('[data-testid="note-table-menu-item"].is-selected')).toHaveCount(1)
  await expect(items.nth(0)).toHaveClass(/is-selected/)

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(2)).toHaveClass(/is-selected/)
  await page.keyboard.press('ArrowUp')
  // Insert column right.
  await expect(items.nth(1)).toHaveClass(/is-selected/)

  await page.keyboard.press('Enter')
  await expect(kit.getByTestId('note-table-menu')).toHaveCount(0)
  await expect.poll(() => columns(kit)).toBe(4)

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
  const first = await cell(kit, 1, 0)
  await page.mouse.click(first.x, first.y)
  await page.keyboard.press('End')
  await page.keyboard.type(' ' + 'a'.repeat(300))
  await expect.poll(() => noteText(page)).toContain('a'.repeat(300))

  // From the cell's start, ArrowDown moves to the cell's second line, not to the next row.
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.type('Z')
  await expect.poll(async () => (await noteText(page)).split('\n')[2]).toMatch(/^\| line1 a*Za* \| x \|$/)
})

test('the column align menu items align every cell of the column', async ({ page, baseURL, browserName }) => {
  const original = '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n'
  const { kit, saves } = await openTable(page, baseURL!, original)
  await columnMenu(page, kit, 1)
  await kit.getByTestId('note-table-menu-item').filter({ hasText: 'Align center' }).dispatchEvent('mousedown')
  await expect(kit.getByTestId('note-table-menu')).toHaveCount(0)
  await expect.poll(async () => (await noteText(page)).split('\n')[1].split('|')[2]).toMatch(/^\s*:-+:\s*$/)

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
    expect(await rows(kit)).toBe(3)
    await append(kit, 'row')
    await expect.poll(() => rows(kit)).toBe(4)

    const at = await cell(kit, 1, 0)
    await page.mouse.click(at.x, at.y)
    await pressCommand(page, kit, 'z')
    await expect.poll(() => rows(kit)).toBe(3)
    expect(await noteText(page)).toBe('| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| x | y | z |\n')
  })

  test('typing in a cell changes only its line, and Tab goes to the next cell', async ({ page, baseURL, browserName }) => {
    const original = '# Cells\n\n| A | B |\n|---|---|\n| one | two |\n'
    const { kit, saves } = await openTable(page, baseURL!, original)
    await caretAfter(page, kit, 'one')
    await page.keyboard.type('!')
    await page.keyboard.press('Tab')
    await page.keyboard.press('End')
    await page.keyboard.type('?')
    await expect.poll(() => noteText(page)).toBe('# Cells\n\n| A | B |\n|---|---|\n| one! | two? |\n')
    const saved = await save(kit, saves)
    if (canReadBlobBodies(browserName)) expect(lineDiff(original, saved)).toEqual({ removed: ['| one | two |'], added: ['| one! | two? |'] })
  })
})
