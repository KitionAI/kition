import { expect, test, type Page } from '@playwright/test'

import historyCopy from '../src/i18n/locales/en-US/history.json' with { type: 'json' }
import { caretAfter, noteText, openNote } from './helpers/noteKit'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * A note's version history on this device: each save keeps the note's replica with a checkpoint
 * in Kition's document store, the history lists the checkpoints and shows a past version, and
 * restoring one brings its text back into the open note, which saves like any edit.
 */
test.setTimeout(180_000)

async function openHistory(page: Page) {
  await page.locator('.document-tab.is-active').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: historyCopy.open }).click()
  await expect(page.getByTestId('history-dialog')).toBeVisible()
}

test('restores an earlier version of a note from its version history', async ({ page, baseURL, browserName }) => {
  const name = 'Plan.md'
  const { kit, saves } = await openNote(page, baseURL!, name, '# Plan\n\nFirst draft.\n', {}, { persist: true })
  const typeAfter = async (line: string, text: string) => {
    await caretAfter(page, kit, line)
    await page.keyboard.type(text)
  }
  // Saves until nothing is unsaved: typing may still be on its way to the engine when Save runs.
  const save = async () => {
    await expect(async () => {
      const before = saves.length
      await kit.getByTestId('note-save').click({ timeout: 2_000 })
      await expect.poll(() => saves.length, { timeout: 5_000 }).toBeGreaterThan(before)
      await expect(kit.getByTestId('note-unsaved')).toHaveCount(0, { timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
  }

  await typeAfter('First draft.', ' Kept.')
  await save()
  await typeAfter('First draft. Kept.', ' Second thoughts.')
  await save()
  await expect.poll(() => noteText(page)).toBe('# Plan\n\nFirst draft. Kept. Second thoughts.\n')

  await openHistory(page)
  const entries = page.getByTestId('history-dialog').getByTestId('history-entry')
  await expect.poll(() => entries.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
  // The older save is listed after the newer one.
  await entries.nth(1).click()
  await expect(page.getByTestId('history-restore')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('history-restore').click()
  await expect(page.getByTestId('history-dialog')).toBeHidden()

  // The open note holds the restored version, and saves it.
  await expect.poll(() => noteText(page), { timeout: 30_000 }).toBe('# Plan\n\nFirst draft. Kept.\n')
  await save()
  if (canReadBlobBodies(browserName)) expect(saves.at(-1)!.bytes.toString('utf8')).toBe('# Plan\n\nFirst draft. Kept.\n')
})
