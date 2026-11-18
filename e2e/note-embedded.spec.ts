import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { caretAfter, changedOnDisk, notePictures, noteText, openNote, waitForNoteText } from './helpers/noteKit'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * Markdown notes in the Note kit (`kit.note`) inside Kition: the kit's own editor in a frame, its
 * Rust engine in a worker (which lays the note out and draws it on a canvas), the file saved
 * through Kition, comments in the replica Kition keeps beside the file, and changes made on disk
 * reaching the open note (`document/fileChanged`).
 */
test.setTimeout(180_000)

/** An existing note, written with CRLF line endings by another editor. */
const PLAN = '# Plan\r\n\r\nGoals for the quarter.\r\n\r\n- Hire\r\n- Ship\r\n'

test('edits, comments on, and saves a note: the file keeps its line endings and never holds the comment', async ({ page, baseURL, browserName }, testInfo) => {
  const name = 'Plan.md'
  const { kit, saves } = await openNote(page, baseURL!, name, PLAN, {}, { persist: true })
  await expect(kit.getByTestId('note-title')).toContainText('Plan')
  // kit-editor's editor frame, in the kit's default display mode (kit.json `ui.display`), around the
  // engine's canvas.
  await expect(kit.locator('.kui-app')).toHaveAttribute('data-mode', 'line')
  await expect(kit.locator('[data-testid="note-canvas"] canvas').first()).toBeVisible()
  await waitForNoteText(page, 'Goals for the quarter.')

  // Typing reaches the engine: the note is unsaved.
  await caretAfter(page, kit, 'Goals for the quarter.')
  await page.keyboard.type(' Then grow.')
  await waitForNoteText(page, 'Goals for the quarter. Then grow.')
  await expect(kit.getByTestId('note-unsaved')).toBeVisible()

  // A comment on the selection is the engine's command; it comes back to the editor.
  await caretAfter(page, kit, 'Ship', { select: true })
  await kit.getByTestId('note-comments-toggle').click()
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

  // Opened again, the note has its comment back: Kition kept the replica beside the file.
  await page.reload()
  const again = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
  await expect(again.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  await waitForNoteText(page, 'Then grow.')
  await expect(again.getByTestId('note-comments-count')).toHaveText('1', { timeout: 30_000 })
})

test('a note follows its file changed on disk: in place without unsaved edits, by the person’s choice with them', async ({ page, baseURL }) => {
  const name = 'Plan.md'
  const original = '# Plan\n\nGoals for the quarter.\n\nClosing words.\n'
  const { kit, host } = await openNote(page, baseURL!, name, original, {}, { persist: true })
  const file = path.join(host.root, name)

  // No unsaved edits: the change shows at once, merged into the open note (no question, the
  // caret where it was).
  const outside = original.replace('Closing words.', 'Closing words, edited outside.')
  await caretAfter(page, kit, 'Goals for the quarter.')
  await fs.writeFile(file, outside)
  await changedOnDisk(host, name)
  await expect.poll(() => noteText(page), { timeout: 10_000 }).toBe(outside)
  await expect(kit.getByTestId('note-disk-changed')).toHaveCount(0)
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)

  // Unsaved edits: the person chooses, and a merge keeps both sides.
  await caretAfter(page, kit, 'Goals for the quarter.')
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

test('a note saves itself a moment after the last change', async ({ page, baseURL, browserName }) => {
  const name = 'Plan.md'
  const { kit, saves } = await openNote(page, baseURL!, name, '# Plan\n\nGoals for the quarter.\n', {}, { persist: true, autosave: true })
  await caretAfter(page, kit, 'Goals for the quarter.')
  await page.keyboard.type(' Saved by itself.')
  await expect.poll(() => saves.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect(kit.getByTestId('note-unsaved')).toHaveCount(0)
  expect(saves.every((save) => save.path === name)).toBe(true)
  if (canReadBlobBodies(browserName)) expect(saves.at(-1)!.bytes.toString('utf8')).toBe('# Plan\n\nGoals for the quarter. Saved by itself.\n')
})

test('keeps a CRLF note with a byte order mark byte for byte, unedited and edited', async ({ page, baseURL, browserName }) => {
  test.skip(!canReadBlobBodies(browserName), 'the saved bytes are read from the request body')
  const name = 'Bom.md'
  const original = '\ufeff# Bom\r\n\r\nFirst line.\r\n'
  const { kit, saves } = await openNote(page, baseURL!, name, original, {}, { persist: true })
  await caretAfter(page, kit, 'First line.')
  await page.keyboard.type(' Edited.')
  await kit.getByTestId('note-save').click()
  await expect.poll(() => saves.length).toBeGreaterThan(0)
  const saved = saves.at(-1)!.bytes
  expect([...saved.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(saved.toString('utf8')).toBe('\ufeff# Bom\r\n\r\nFirst line. Edited.\r\n')
})

test('an image pasted into a note is kept in the workspace, beside the note', async ({ page, baseURL, browserName }) => {
  const name = 'Notes/Pictures.md'
  const { kit, host } = await openNote(page, baseURL!, name, '# Pictures\n\nThe end.\n', {}, { persist: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGMIc70CRAwQCgAmOgW99kNaOgAAAABJRU5ErkJggg==', 'base64')
  // On a line of its own, so the note draws the picture once the caret leaves it.
  await caretAfter(page, kit, 'The end.')
  await page.keyboard.press('Enter')
  await kit.getByTestId('kit-text-sink').evaluate((sink, bytes) => {
    const data = new DataTransfer()
    data.items.add(new File([new Uint8Array(bytes)], 'dot.png', { type: 'image/png' }))
    sink.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, [...png])
  // The kit creates it through KitFiles (`files/create`): a new file, never replacing one, beside the note.
  const pasted = async () => (await fs.readdir(path.join(host.root, 'Notes'))).filter((file) => file.startsWith('pasted-') && file.endsWith('.png'))
  await expect.poll(pasted, { timeout: 15_000 }).toHaveLength(1)
  if (canReadBlobBodies(browserName)) expect((await fs.readFile(path.join(host.root, 'Notes', (await pasted())[0]))).equals(png)).toBe(true)
  // The note links it relative to its folder, and draws it once the caret is elsewhere.
  await expect.poll(() => noteText(page)).toContain(`](${(await pasted())[0]})`)
  await page.keyboard.press('ArrowUp')
  await expect.poll(() => notePictures(page), { timeout: 15_000 }).toEqual([expect.stringContaining('pasted-')])
})
