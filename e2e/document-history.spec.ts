import { expect, test, type Page } from '@playwright/test'

import historyCopy from '../src/i18n/locales/en-US/history.json' with { type: 'json' }
import { readDocumentStoreState } from './helpers/documentStore'
import { DEFAULT_DOC_PATH, mockDesktopBridge, readDocumentIdOf, readMarkdownFileText } from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

// A document's version history on this device: saves append changes to the document store, opening the document
// records a checkpoint, the history lists the checkpoints, shows a past version read-only, and restores it as one new
// change the person can undo.

function editor(page: Page) {
  return page.getByTestId('document-editor').locator('.cm-content').first()
}

async function waitForDocument(page: Page) {
  await expect(editor(page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => readDocumentIdOf(page)).toBeTruthy()
}

async function openHistory(page: Page) {
  await page.locator('.document-tab.is-active').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: historyCopy.open }).click()
  await expect(page.getByTestId('history-dialog')).toBeVisible()
}

test('restores a checkpoint from the version history as one undoable change', async ({ page }) => {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, '# Plan\n\nFirst draft.\n')
  await page.goto('/')
  await waitForDocument(page)
  const docId = (await readDocumentIdOf(page))!
  // Opening the document recorded where it starts.
  await expect.poll(async () => (await readDocumentStoreState(page)).histories[docId]?.length ?? 0).toBe(1)

  await editor(page).locator('.cm-line', { hasText: 'First draft.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Second thoughts.')
  await expect.poll(() => readMarkdownFileText(page), { timeout: 10_000 }).toBe('# Plan\n\nFirst draft. Second thoughts.\n')
  // The save appended its changes after the stored snapshot.
  await expect.poll(async () => (await readDocumentStoreState(page)).heads[docId]?.changes.length ?? 0).toBeGreaterThan(0)

  // Opened again, the document records a second checkpoint, and is the snapshot with its changes.
  await page.reload()
  await waitForDocument(page)
  await expect(editor(page)).toContainText('Second thoughts.')
  await expect.poll(async () => (await readDocumentStoreState(page)).histories[docId]?.length ?? 0).toBe(2)

  await openHistory(page)
  const entries = page.getByTestId('history-dialog').getByTestId('history-entry')
  await expect(entries).toHaveCount(2)
  // The older one (listed last) is the first draft, shown read-only.
  await entries.last().click()
  await expect(page.getByTestId('history-preview-text')).toHaveText('# Plan\n\nFirst draft.\n')
  await page.getByTestId('history-restore').click()
  await expect(page.getByTestId('history-dialog')).toBeHidden()

  await expect(editor(page)).not.toContainText('Second thoughts.')
  await expect.poll(() => readMarkdownFileText(page), { timeout: 10_000 }).toBe('# Plan\n\nFirst draft.\n')
  const origins = async () => ((await readDocumentStoreState(page)).histories[docId] ?? []).map((checkpoint) => checkpoint.origin)
  await expect.poll(origins).toContain('restore')

  // The restore is one undo step of its own: typing after it undoes first, then the restore.
  await editor(page).locator('.cm-line', { hasText: 'First draft.' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await expect(editor(page)).toContainText('First draft.!')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).not.toContainText('First draft.!')
  await expect(editor(page)).not.toContainText('Second thoughts.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor(page)).toContainText('Second thoughts.')
  await expect.poll(() => readMarkdownFileText(page), { timeout: 10_000 }).toBe('# Plan\n\nFirst draft. Second thoughts.\n')
})
