import { expect, test, type Page } from '@playwright/test'

import documentCopy from '../src/i18n/locales/en-US/document.json' with { type: 'json' }
import workspaceCopy from '../src/i18n/locales/en-US/workspace.json' with { type: 'json' }
import { readDocumentStoreState } from './helpers/documentStore'
import {
  countMarkdownFileWrites,
  DEFAULT_DOC_PATH,
  deleteMarkdownFileExternally,
  failMarkdownFileWrites,
  mockDesktopBridge,
  readDocumentIdOf,
  readMarkdownFileLastWriteAt,
  readMarkdownFileText,
  writeMarkdownFileExternally,
} from './helpers/markdownDocument'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

// A Markdown document on its KDM replica: typing is saved to the plain `.md` file through guarded
// writes, a change made to the file on disk merges with unsaved typing, the file keeps its line
// endings and byte order mark, its identity (document id) survives reloads and renames, a closing
// tab writes its last keystrokes, and a save that keeps failing asks before discarding them.

/** The session's save delay after an edit (`SAVE_DELAY_MS`). */
const SAVE_DELAY_MS = 300

async function openFixture(page: Page, content: string) {
  await mockLocalWorkspaceApi(page)
  await mockDesktopBridge(page, content)
  await page.goto('/')
  await waitForDocument(page)
}

/** Waits until the document's editor is bound to its replica and the store knows its id. */
async function waitForDocument(page: Page, path = DEFAULT_DOC_PATH) {
  await expect(editor(page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => readDocumentIdOf(page, path)).toBeTruthy()
}

function editor(page: Page) {
  return page.getByTestId('document-editor').locator('.cm-content').first()
}

/** Puts the caret at the end of the line showing `text`. */
async function caretAtEndOf(page: Page, text: string) {
  await editor(page).locator('.cm-line', { hasText: text }).first().click()
  await page.keyboard.press('End')
}

async function expectFileText(page: Page, text: string, path = DEFAULT_DOC_PATH) {
  await expect.poll(() => readMarkdownFileText(page, path), { timeout: 10_000 }).toBe(text)
}

function treeRow(page: Page, title: string) {
  return page.locator('.document-tree-row', { hasText: title }).first()
}

function closeTabButton(page: Page) {
  return page.locator('.document-tab-list .document-tab-close').first()
}

/** No document tab is open and no editor shows a document. */
async function expectNoOpenDocument(page: Page) {
  await expect(page.locator('.document-tab-list .document-tab')).toHaveCount(0)
  await expect(page.getByTestId('document-editor').locator('.cm-editor')).toHaveCount(0)
}

/** Presses `key` with the modifier CodeMirror and the app read as Mod: from the page's platform, not the host's. */
async function pressMod(page: Page, key: string) {
  const isMacPage = await page.evaluate(() => /Mac/.test(navigator.platform))
  await page.keyboard.press(`${isMacPage ? 'Meta' : 'Control'}+${key}`)
}

test('saves typing and opens the same file and document after a reload', async ({ page }) => {
  await openFixture(page, '# Notes\n\nFirst line.\n')
  const docId = await readDocumentIdOf(page)

  await caretAtEndOf(page, 'First line.')
  await page.keyboard.type(' Typed.')
  const saved = '# Notes\n\nFirst line. Typed.\n'
  await expectFileText(page, saved)
  expect(await readDocumentIdOf(page)).toBe(docId)

  await page.reload()
  await waitForDocument(page)
  await expect(editor(page)).toContainText('First line. Typed.')
  expect(await readDocumentIdOf(page)).toBe(docId)
  // The replica holds what the file holds: opening it writes nothing.
  await page.waitForTimeout(1_000)
  expect(await readMarkdownFileText(page)).toBe(saved)
  expect(await countMarkdownFileWrites(page)).toBe(0)
  const state = await readDocumentStoreState(page)
  expect(Object.keys(state.entries)).toEqual([docId])
  expect(state.entries[docId!]!.meta.path).toBe(DEFAULT_DOC_PATH)
})

test('merges a change made to the file on disk with unsaved typing in one write', async ({ page }) => {
  await openFixture(page, '# Plan\n\nAlpha paragraph.\n\nOmega paragraph.\n')
  const writesBefore = await countMarkdownFileWrites(page)

  await caretAtEndOf(page, 'Alpha paragraph.')
  await page.keyboard.type(' Local.')
  await writeMarkdownFileExternally(page, '# Plan\n\nAlpha paragraph.\n\nOmega paragraph. Disk.\n')
  // The typing had not been saved when the file changed on disk.
  expect(await countMarkdownFileWrites(page)).toBe(writesBefore)

  const merged = '# Plan\n\nAlpha paragraph. Local.\n\nOmega paragraph. Disk.\n'
  await expectFileText(page, merged)
  await expect(editor(page)).toContainText('Alpha paragraph. Local.')
  await expect(editor(page)).toContainText('Omega paragraph. Disk.')
  // The change event merged the file before saving: one write, not a refused one and a retry.
  await page.waitForTimeout(1_500)
  expect(await countMarkdownFileWrites(page)).toBe(writesBefore + 1)
  expect(await readMarkdownFileText(page)).toBe(merged)
})

test('keeps a CRLF file with a byte order mark byte for byte, unedited and edited', async ({ page }) => {
  const original = '\uFEFF# Windows\r\n\r\nFirst line.\r\n\r\nSecond line.\r\n'
  await openFixture(page, original)
  await expect(editor(page)).toContainText('Second line.')
  expect(await editor(page).textContent()).not.toContain('\uFEFF')

  // Opened and closed without an edit: never written.
  await page.waitForTimeout(1_000)
  await closeTabButton(page).click()
  await expectNoOpenDocument(page)
  await page.waitForTimeout(500)
  expect(await readMarkdownFileText(page)).toBe(original)
  expect(await countMarkdownFileWrites(page)).toBe(0)

  // One edit after reopening it: the file keeps CRLF and the byte order mark.
  await treeRow(page, 'table-test').click()
  await waitForDocument(page)
  await caretAtEndOf(page, 'First line.')
  await page.keyboard.type(' Edited.')
  await expectFileText(page, '\uFEFF# Windows\r\n\r\nFirst line. Edited.\r\n\r\nSecond line.\r\n')
  expect(await countMarkdownFileWrites(page)).toBe(1)
})

test('keeps the document id when the file is renamed in the tree and reopened', async ({ page }) => {
  await openFixture(page, '# Draft\n\nBody text.\n')
  const docId = await readDocumentIdOf(page)

  const row = treeRow(page, 'table-test')
  await row.hover()
  await row.locator('.document-tree-action[aria-label="More actions"]').click()
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const renameInput = page.locator('.document-tree-rename-input')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('Renamed')
  await renameInput.press('Enter')

  await expect.poll(() => readMarkdownFileText(page, 'Renamed.md')).toBe('# Draft\n\nBody text.\n')
  expect(await readMarkdownFileText(page, DEFAULT_DOC_PATH)).toBeNull()
  await expect.poll(async () => (await readDocumentStoreState(page)).index.entries).toEqual({ 'Renamed.md': docId })

  // Reopened from the tree, the renamed file is the same document, saved at its new path.
  await closeTabButton(page).click()
  await expectNoOpenDocument(page)
  await treeRow(page, 'Renamed').click()
  await waitForDocument(page, 'Renamed.md')
  await caretAtEndOf(page, 'Body text.')
  await page.keyboard.type(' More.')
  await expectFileText(page, '# Draft\n\nBody text. More.\n', 'Renamed.md')
  const state = await readDocumentStoreState(page)
  expect(state.index.entries).toEqual({ 'Renamed.md': docId })
  expect(Object.keys(state.entries)).toEqual([docId])
  expect(state.entries[docId!]!.meta.path).toBe('Renamed.md')
})

test('saves typing when the tab closes within 100 ms of the last keystroke', async ({ page }) => {
  await openFixture(page, '# Quick\n\nClose me.\n')
  const writesBefore = await countMarkdownFileWrites(page)

  await caretAtEndOf(page, 'Close me.')
  const typingStartedAt = await page.evaluate(() => performance.now())
  await page.keyboard.type('!')
  const typedAt = Date.now()
  // Close the tab from inside the page, so nothing waits between the keystroke and the close.
  const closing = await page.evaluate((path) => {
    const files = window.__KITION_MARKDOWN_E2E_FILES__
    if (!files) throw new Error('The Markdown e2e files are unavailable')
    const writes = files.writes[path] ?? 0
    const close = document.querySelector<HTMLButtonElement>('.document-tab-list .document-tab-close')
    if (!close) throw new Error('The document tab has no close button')
    const at = performance.now()
    close.click()
    return { at, writes }
  }, DEFAULT_DOC_PATH)
  expect(Date.now() - typedAt).toBeLessThan(100)
  expect(closing.writes).toBe(writesBefore)

  await expectNoOpenDocument(page)
  await expectFileText(page, '# Quick\n\nClose me.!\n')
  // Written by the close itself, before the save delay after the keystroke would have run out.
  const lastWriteAt = await readMarkdownFileLastWriteAt(page)
  expect(lastWriteAt).not.toBeNull()
  expect(lastWriteAt! - typingStartedAt).toBeLessThan(SAVE_DELAY_MS)
  expect(await countMarkdownFileWrites(page)).toBe(writesBefore + 1)
})

test('closes a document whose save keeps failing only after its changes are discarded, leaving the file as it was', async ({ page }) => {
  const original = '# Offline\n\nKeep this.\n'
  await openFixture(page, original)
  await failMarkdownFileWrites(page, 'The folder is gone')

  await caretAtEndOf(page, 'Keep this.')
  await page.keyboard.type(' Unsaved.')
  await expect.poll(() => countMarkdownFileWrites(page)).toBeGreaterThan(0)

  // Keeping the tab open keeps the document and its unsaved typing. The tab closes with Mod+W
  // (toast-placement.spec.ts covers closing it with its close button while the toast shows).
  const confirmation = page.getByTestId('document-close-unsaved-confirm')
  await pressMod(page, 'w')
  await expect(confirmation).toContainText(workspaceCopy.documentFile.closeUnsavedMessage)
  await expect(confirmation.getByTestId('confirm-btn')).toHaveText(workspaceCopy.documentFile.closeUnsavedDiscard)
  await expect(confirmation.getByTestId('cancel-btn')).toHaveText(workspaceCopy.documentFile.closeUnsavedKeep)
  await confirmation.getByTestId('cancel-btn').click()
  await expect(confirmation).toHaveCount(0)
  await expect(editor(page)).toContainText('Keep this. Unsaved.')
  expect(await readMarkdownFileText(page)).toBe(original)

  await pressMod(page, 'w')
  await confirmation.getByTestId('confirm-btn').click()
  await expectNoOpenDocument(page)
  const writes = await countMarkdownFileWrites(page)
  // Writes would succeed now, so any save or retry left after discarding would change the file.
  await failMarkdownFileWrites(page, null)
  await page.waitForTimeout(2_500)
  expect(await countMarkdownFileWrites(page)).toBe(writes)
  expect(await readMarkdownFileText(page)).toBe(original)

  // Reopened, the document shows the file without the discarded typing.
  await treeRow(page, 'table-test').click()
  await waitForDocument(page)
  await expect(editor(page)).toContainText('Keep this.')
  await expect(editor(page)).not.toContainText('Unsaved.')
})

test('undo after a reload reverts only the typing of the new page load', async ({ page }) => {
  // The replica's undo history lives in memory: the stored replica keeps the text, not the undo
  // steps, so a reloaded document has nothing of the previous session to undo.
  await openFixture(page, '# History\n\nLine.\n')
  await caretAtEndOf(page, 'Line.')
  await page.keyboard.type(' One')
  await expectFileText(page, '# History\n\nLine. One\n')

  await page.reload()
  await waitForDocument(page)
  await caretAtEndOf(page, 'Line. One')
  await pressMod(page, 'z')
  await page.waitForTimeout(SAVE_DELAY_MS * 3)
  await expect(editor(page)).toContainText('Line. One')
  expect(await readMarkdownFileText(page)).toBe('# History\n\nLine. One\n')
  expect(await countMarkdownFileWrites(page)).toBe(0)

  await page.keyboard.type(' Two')
  await expectFileText(page, '# History\n\nLine. One Two\n')
  await pressMod(page, 'z')
  await expectFileText(page, '# History\n\nLine. One\n')
  await expect(editor(page)).toContainText('Line. One')
  await expect(editor(page)).not.toContainText('Two')
  // A second undo has nothing left: the previous session's typing stays.
  await pressMod(page, 'z')
  await page.waitForTimeout(SAVE_DELAY_MS * 3)
  expect(await readMarkdownFileText(page)).toBe('# History\n\nLine. One\n')
  await expect(editor(page)).toContainText('Line. One')
})

test('the browser’s own undo and redo (the Edit menu) run on the replica, not as typing', async ({ page }) => {
  await openFixture(page, '# Menu\n\nLine.\n')
  await caretAtEndOf(page, 'Line.')
  await page.keyboard.type(' Typed')
  await expectFileText(page, '# Menu\n\nLine. Typed\n')

  // The desktop shell's Edit > Undo and Redo reach the editor as `beforeinput` history events.
  const nativeHistory = (inputType: 'historyUndo' | 'historyRedo') => editor(page).evaluate((content, type) => {
    const event = new InputEvent('beforeinput', { inputType: type, bubbles: true, cancelable: true })
    content.dispatchEvent(event)
    return event.defaultPrevented
  }, inputType)
  expect(await nativeHistory('historyUndo')).toBe(true)
  await expectFileText(page, '# Menu\n\nLine.\n')
  await expect(editor(page)).not.toContainText('Typed')
  expect(await nativeHistory('historyRedo')).toBe(true)
  await expectFileText(page, '# Menu\n\nLine. Typed\n')
  await expect(editor(page)).toContainText('Line. Typed')
})

test('a file deleted outside Kition while open is saved again only when the person asks', async ({ page }) => {
  await openFixture(page, '# Gone\n\nKeep this.\n')
  await caretAtEndOf(page, 'Keep this.')
  await page.keyboard.type(' Typed.')
  await expectFileText(page, '# Gone\n\nKeep this. Typed.\n')

  await deleteMarkdownFileExternally(page)
  await page.keyboard.type(' More.')
  const notice = page.locator('[data-sonner-toast]', { hasText: documentCopy.session.fileMissing })
  await expect(notice).toBeVisible({ timeout: 10_000 })
  await expect(notice).toContainText(documentCopy.session.fileMissingDescription)
  await page.waitForTimeout(SAVE_DELAY_MS * 3)
  expect(await readMarkdownFileText(page)).toBeNull()

  await notice.getByRole('button', { name: documentCopy.session.recreate }).click()
  await expectFileText(page, '# Gone\n\nKeep this. Typed. More.\n')
  await expect(notice).toHaveCount(0)
})
