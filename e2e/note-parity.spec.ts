import { expect, test } from '@playwright/test'

import { caretAfter, noteText, openNote, pressCommand } from './helpers/noteKit'

/**
 * The Note kit in Kition behaves as its reference editor's live preview (W3-64): a sample of the
 * kit's own parity suite (kition-note `web/tests/`) on the pinned package in KitFrame. Brackets
 * pair and a closer steps over its pair, Enter continues a list, the command key with L checks a
 * task, Alt+Up takes the caret to its line's start (measured in the reference editor, which does
 * not move the line), the caret blinks, and a right click opens the editor's menu.
 */
test.setTimeout(180_000)

test('edits a note as the reference editor does', async ({ page, baseURL }) => {
  const text = '# Parity\n\n- [ ] first task\n\nalpha\nbeta\n\nend\n'
  const { kit } = await openNote(page, baseURL!, 'Parity.md', text)

  await caretAfter(page, kit, 'end')
  await page.keyboard.type(' (x')
  await expect.poll(() => noteText(page)).toContain('end (x)')
  await page.keyboard.type(')')
  await expect.poll(() => noteText(page)).toContain('end (x)\n')

  await caretAfter(page, kit, 'first task')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second')
  await expect.poll(() => noteText(page)).toContain('- [ ] first task\n- [ ] second')
  await pressCommand(page, kit, 'l')
  await expect.poll(() => noteText(page)).toContain('- [x] second')

  await caretAfter(page, kit, 'beta')
  await page.keyboard.press('Alt+ArrowUp')
  await page.keyboard.type('X')
  await expect.poll(() => noteText(page)).toContain('alpha\nXbeta')

  const caret = kit.getByTestId('note-caret')
  await expect(caret).toHaveCount(1)
  const opacities = new Set<string>()
  for (let i = 0; i < 24; i += 1) {
    opacities.add(await caret.evaluate((element) => getComputedStyle(element).opacity).catch(() => 'gone'))
    await page.waitForTimeout(100)
  }
  expect([...opacities]).toEqual(expect.arrayContaining(['0', '1']))

  await kit.getByTestId('note-canvas').click({ button: 'right', position: { x: 300, y: 120 } })
  await expect(kit.getByTestId('note-context-menu')).toBeVisible()
  await expect(kit.getByTestId('note-menu-copy')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(kit.getByTestId('note-context-menu')).toHaveCount(0)
})

test('draws front matter as a properties block', async ({ page, baseURL }) => {
  const text = '---\ntags:\n  - alpha\n  - beta\ndone: true\n---\n\n# Body\n'
  const { kit } = await openNote(page, baseURL!, 'Properties.md', text)

  await expect(kit.getByTestId('note-property')).toHaveCount(2)
  await expect(kit.getByTestId('note-properties-add')).toBeVisible()
  await expect(kit.locator('[data-testid="note-property"][data-key="tags"] .note-property-pill')).toHaveText(['alpha×', 'beta×'])
  await kit.locator('[data-key="done"] input[type="checkbox"]').click()
  await expect.poll(() => noteText(page)).toContain('done: false')
})

test('draws a Mermaid block as its diagram', async ({ page, baseURL }) => {
  const text = 'Intro\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n\nAfter\n'
  const { kit } = await openNote(page, baseURL!, 'Diagram.md', text)

  const diagram = kit.getByTestId('note-diagram')
  await expect(diagram).toHaveCount(1, { timeout: 30_000 })
  await expect(diagram.locator('.note-diagram-svg > svg')).toContainText('Start')
  await diagram.hover()
  await kit.getByTestId('note-diagram-edit').click()
  await expect(diagram).toHaveCount(0)
  await page.keyboard.type('%% edited\n')
  await expect.poll(() => noteText(page)).toContain('```mermaid\n%% edited\ngraph TD')
})

test('draws an HTML block as its HTML', async ({ page, baseURL }) => {
  const text = 'Intro\n\n<details>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n\nAfter\n'
  const { kit } = await openNote(page, baseURL!, 'Details.md', text)

  const block = kit.locator('[data-testid="note-diagram"][data-kind="html"]')
  await expect(block).toHaveCount(1, { timeout: 30_000 })
  await expect(block.locator('summary')).toHaveText('More')
  const folded = (await block.boundingBox())!.height
  await block.locator('summary').click()
  await expect.poll(async () => (await block.boundingBox())!.height).toBeGreaterThan(folded + 10)
})

test('takes back a run of typing in one Undo', async ({ page, baseURL }) => {
  const { kit } = await openNote(page, baseURL!, 'Undo.md', '# Undo\n\nstart\n')
  await caretAfter(page, kit, 'start')
  await page.keyboard.type(' hello world')
  await expect.poll(() => noteText(page)).toContain('start hello world')
  await pressCommand(page, kit, 'z')
  await expect.poll(() => noteText(page)).toBe('# Undo\n\nstart\n')
})
