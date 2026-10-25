import { expect, test } from '@playwright/test'

import { caretAfter, noteText, openNote, pressCommand } from './helpers/noteKit'

/**
 * The Note kit in Kition behaves as Obsidian's live preview (W3-64): a sample of the kit's own
 * parity suite (kition-note web/tests/obsidian.mjs) on the pinned package in KitFrame. Brackets
 * pair and a closer steps over its pair, Enter continues a list, the command key with L checks a
 * task, Alt+Up moves a line, the caret blinks, and a right click opens the editor's menu.
 */
test.setTimeout(180_000)

test('edits a note as Obsidian does', async ({ page, baseURL }) => {
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
  await expect.poll(() => noteText(page)).toContain('beta\nalpha')

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
