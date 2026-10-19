import { expect, test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { openInKitFrame } from './helpers/embeddedKit'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * The Document kit (`kit.document`, packages/document-kit), which Kition does not use for its own
 * Markdown documents: a development build opens `.md` files in it when this flag is set
 * (`documentKitForDevelopment` in kitEditors.ts).
 */
const DOCUMENT_KIT_DEV_FLAG = 'kition.dev.documentKit'
/** Set in the tab's session storage, the next load opens documents natively again. */
const NATIVE_MARK = 'e2e.document-embedded.native'

/** The kit's package (`scripts/build-kit-ui.sh document`): its TypeScript engine and its editor. */
const kitDir = path.join(process.cwd(), 'public', 'kits', 'document-ui')
const built = existsSync(path.join(kitDir, 'engine', 'kition_document_engine.js')) && existsSync(path.join(kitDir, 'kit-ui.json'))

/** An existing Markdown document, written with CRLF line endings by another editor. */
const PLAN = '# Plan\r\n\r\nGoals for the quarter.\r\n\r\n- Hire\r\n- Ship\r\n'

async function openDocumentsInKitUntilNative(page: Page) {
  await page.addInitScript(
    ({ flag, mark }) => {
      if (window.sessionStorage.getItem(mark)) window.localStorage.removeItem(flag)
      else window.localStorage.setItem(flag, '1')
    },
    { flag: DOCUMENT_KIT_DEV_FLAG, mark: NATIVE_MARK },
  )
}

test('opens a Markdown document in the Document kit, edits and comments on it, saves it, and Kition opens the saved file natively', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!built, 'the Document kit is not built into public/kits/document-ui (scripts/build-kit-ui.sh document)')
  test.setTimeout(180_000)
  await openDocumentsInKitUntilNative(page)
  const name = 'Plan.md'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, name, Buffer.from(PLAN), {}, { persist: true })
  try {
    // Kition's own Markdown editor, inside the kit's frame, over the kit's TypeScript engine.
    const editor = kit.getByTestId('document-editor')
    await expect(editor).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('document-title')).toHaveText(name)
    await expect(editor.locator('.cm-content')).toContainText('Goals for the quarter.')
    await expect(editor.locator('.cm-content')).toContainText('Ship')

    // Typing in the editor reaches the engine: the document is unsaved.
    await editor.locator('.cm-line', { hasText: 'Goals for the quarter.' }).click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Then grow.')
    await expect(editor.locator('.cm-content')).toContainText('Goals for the quarter. Then grow.')
    await expect(kit.getByTestId('document-unsaved')).toBeVisible()

    // A comment on the selection is the engine's command, and comes back to the editor's replica.
    await kit.getByTestId('document-comments-toggle').click()
    await editor.locator('.cm-line', { hasText: 'Ship' }).dblclick()
    await kit.getByTestId('document-comments-new').click()
    await kit.getByTestId('document-comment-panel-new-input').fill('Which release?')
    await kit.getByTestId('document-comment-panel-new-send').click()
    await expect(kit.getByTestId('document-comment-panel-thread')).toHaveCount(1)
    await expect(kit.getByTestId('document-comment-panel-comment')).toContainText('Which release?')
    await expect(kit.getByTestId('document-comment-panel-thread')).toContainText('Ship')
    await expect(kit.getByTestId('document-comments-count')).toHaveText('1')
    await page.screenshot({ path: testInfo.outputPath('document-embedded.png') })

    await kit.getByTestId('document-save').click()
    await expect(kit.getByTestId('document-unsaved')).toHaveCount(0, { timeout: 30_000 })
    // The editor's replica and the engine's exchanged every change without a failure.
    await expect(kit.getByText('The document could not sync with its engine')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual([name])
    if (canReadBlobBodies(browserName)) {
      // The file keeps its line endings, takes the edit, and never holds the comment.
      expect(saves[0].bytes.toString('utf8')).toBe('# Plan\r\n\r\nGoals for the quarter. Then grow.\r\n\r\n- Hire\r\n- Ship\r\n')
    }

    // Reopened without the kit: Kition's native editor shows the saved file.
    await page.evaluate((mark) => window.sessionStorage.setItem(mark, '1'), NATIVE_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Plan' }).first().click()
    const native = page.getByTestId('document-editor').locator('.cm-content').first()
    await expect(native).toContainText('Goals for the quarter. Then grow.', { timeout: 30_000 })
    await expect(page.getByTestId('kit-frame')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('document-native.png') })
  } finally {
    await host.dispose()
  }
})
