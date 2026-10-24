import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { changedOnDisk, noteText, openNote } from './helpers/noteKit'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * Markdown notes in the Note kit (`kit.note`) inside Kition: the kit's own editor in a frame, its
 * Rust engine in a worker, the file saved through Kition, comments in the replica Kition keeps
 * beside the file, and changes made on disk reaching the open note (`document/fileChanged`).
 */
test.setTimeout(180_000)

/** An existing note, written with CRLF line endings by another editor. */
const PLAN = '# Plan\r\n\r\nGoals for the quarter.\r\n\r\n- Hire\r\n- Ship\r\n'

test('edits, comments on, and saves a note: the file keeps its line endings and never holds the comment', async ({ page, baseURL, browserName }, testInfo) => {
  const name = 'Plan.md'
  const { kit, saves } = await openNote(page, baseURL!, name, PLAN, {}, { persist: true })
  const content = kit.locator('.cm-content')
  await expect(kit.getByTestId('note-title')).toContainText('Plan')
  // kit-ui's editor frame, in the kit's default display mode (kit.json `ui.display`).
  await expect(kit.locator('.kui-app')).toHaveAttribute('data-mode', 'line')
  await expect(content).toContainText('Goals for the quarter.')

  // Typing reaches the engine: the note is unsaved.
  await kit.locator('.cm-line', { hasText: 'Goals for the quarter.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Then grow.')
  await expect(content).toContainText('Goals for the quarter. Then grow.')
  await expect(kit.getByTestId('note-unsaved')).toBeVisible()

  // A comment on the selection is the engine's command; it comes back to the editor.
  await kit.getByTestId('note-comments-toggle').click()
  await kit.locator('.cm-line', { hasText: 'Ship' }).dblclick()
  await kit.getByTestId('note-comments-new').click()
  await kit.getByTestId('note-comment-panel-new-input').fill('Which release?')
  await kit.getByTestId('note-comment-panel-new-send').click()
  await expect(kit.getByTestId('note-comment-panel-thread')).toHaveCount(1)
  await expect(kit.getByTestId('note-comment-panel-comment')).toContainText('Which release?')
  await expect(kit.getByTestId('note-comments-count')).toHaveText('1')
  await page.screenshot({ path: testInfo.outputPath('note-embedded.png') })

  await kit.getByTestId('note-save').click()
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0, { timeout: 30_000 })
  expect(saves.map((save) => save.path)).toEqual([name])
  if (canReadBlobBodies(browserName)) {
    expect(saves[0].bytes.toString('utf8')).toBe('# Plan\r\n\r\nGoals for the quarter. Then grow.\r\n\r\n- Hire\r\n- Ship\r\n')
  }
})

test('a note follows its file changed on disk: in place without unsaved edits, by the person’s choice with them', async ({ page, baseURL }) => {
  const name = 'Plan.md'
  const original = '# Plan\n\nGoals for the quarter.\n\nClosing words.\n'
  const { kit, host } = await openNote(page, baseURL!, name, original, {}, { persist: true })
  const file = path.join(host.root, name)

  // No unsaved edits: the change shows at once, merged into the open note (no question, the
  // caret where it was).
  const outside = original.replace('Closing words.', 'Closing words, edited outside.')
  await kit.locator('.cm-line', { hasText: 'Goals for the quarter.' }).click()
  await fs.writeFile(file, outside)
  await changedOnDisk(host, name)
  await expect.poll(() => noteText(page), { timeout: 10_000 }).toBe(outside)
  await expect(kit.getByTestId('note-disk-changed')).toHaveCount(0)
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)

  // Unsaved edits: the person chooses, and a merge keeps both sides.
  await kit.locator('.cm-line', { hasText: 'Goals for the quarter.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Mine.')
  await expect(kit.getByTestId('note-unsaved')).toBeVisible()
  const theirs = outside.replace('Closing words, edited outside.', 'Closing words, edited outside again.')
  await fs.writeFile(file, theirs)
  await changedOnDisk(host, name)
  await expect(kit.getByTestId('note-disk-changed')).toBeVisible({ timeout: 10_000 })
  await kit.getByTestId('note-disk-merge').click()
  await expect(kit.getByTestId('note-disk-changed')).toHaveCount(0)
  await expect.poll(() => noteText(page)).toBe('# Plan\n\nGoals for the quarter. Mine.\n\nClosing words, edited outside again.\n')
})
