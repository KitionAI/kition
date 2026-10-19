import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, openSharedLink, openTabMenu, signedIn, startKitionPro, useSyncServer } from './helpers/kitionPro'

// Comments across people on a shared Markdown document (Kition Pro, kition-sync 1.6): Alice shares
// it with Bob as a commenter, Bob comments (Alice sees it live) but cannot change the text, Alice
// makes him a viewer and then removes him from the document, which stays with Bob as a local copy
// where Alice's comments are read-only history.

const NOTES = '# Launch notes\n\nFirst line.\n'

const editor = (page: Page) => page.getByTestId('document-editor').locator('.cm-content').first()
const text = (page: Page) => editor(page).innerText()
const tabs = (page: Page) => page.locator('.document-tab-list')
const comments = (page: Page) => page.getByTestId('document-comments')

async function openNotes(page: Page) {
  await page.locator('.document-tree-row', { hasText: 'Notes' }).first().click()
  await expect(editor(page)).toBeVisible({ timeout: 30_000 })
}

async function showComments(page: Page) {
  if (!(await comments(page).isVisible())) await page.getByTestId('document-comments-toggle').click()
  await expect(comments(page)).toBeVisible()
}

/** Selects the line showing `line` and comments `body` on it. */
async function commentOn(page: Page, line: string, body: string) {
  await editor(page).locator('.cm-line', { hasText: line }).first().click({ clickCount: 3 })
  await showComments(page)
  await page.getByTestId('document-comments-new').click()
  await page.getByTestId('document-comments-input').fill(body)
  await page.getByTestId('document-comments-send').click()
}

/** Opens the share dialog of the tab titled `title` (an already shared document shows its room). */
async function openShareDialog(page: Page, title: string) {
  await (await openTabMenu(page, title, 'Share for co-editing')).click()
  await expect(page.getByTestId('collab-share-dialog')).toBeVisible({ timeout: 30_000 })
}

test('a commenter comments on a shared Markdown document, cannot change its text, and is made a viewer, then removed', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    // Alice shares her notes with a link that lets people comment.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openKitWorkspace(pageA, baseURL!, { 'Notes.md': Buffer.from(NOTES) }, signedIn(DEV_PRINCIPALS.alice))
    await openNotes(pageA)
    await openShareDialog(pageA, 'Notes')
    const link = pageA.getByTestId('collab-share-link')
    const editLink = await link.inputValue()
    await pageA.getByTestId('collab-share-access-comment').click()
    await expect(link).not.toHaveValue(editLink, { timeout: 15_000 })
    const commentLink = await link.inputValue()
    await pageA.keyboard.press('Escape')
    await expect(pageA.getByTestId('collab-share-dialog')).toHaveCount(0)
    await expect(tabs(pageA).getByTestId('collab-status')).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens it: his text is read-only, and the tab says he may comment.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, commentLink)
    await expect(editor(pageB)).toContainText('First line.', { timeout: 30_000 })
    await expect(tabs(pageB).getByTestId('collab-comment-only')).toBeVisible({ timeout: 15_000 })
    await expect(tabs(pageB).getByTestId('collab-status')).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(editor(pageB)).toHaveAttribute('aria-readonly', 'true', { timeout: 15_000 })
    await expect(tabs(pageA).getByTestId('collab-peer')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })

    // Bob comments on the first line: Alice sees it live.
    await commentOn(pageB, 'First line.', 'Should this say more?')
    await expect(comments(pageB).getByTestId('document-comment-body')).toHaveText(['Should this say more?'])
    const commented = Date.now()
    await expect(pageA.getByTestId('document-comments-count')).toHaveText('1', { timeout: 5_000 })
    testInfo.annotations.push({ type: 'live comment to the other window', description: `${Date.now() - commented} ms` })
    await showComments(pageA)
    await expect(comments(pageA).getByTestId('document-comment')).toHaveAttribute('data-author', 'dev:bob')
    await expect(comments(pageA).getByTestId('document-comment-body')).toHaveText(['Should this say more?'])

    // Alice replies; Bob sees the reply.
    await comments(pageA).getByTestId('document-comment-reply-input').fill('Yes, the date.')
    await comments(pageA).getByTestId('document-comment-reply-send').click()
    await expect(comments(pageB).getByTestId('document-comment-body')).toHaveText(['Should this say more?', 'Yes, the date.'], { timeout: 10_000 })

    // Alice opens a thread of her own.
    await commentOn(pageA, 'Launch notes', 'Alice’s own note.')
    await expect(comments(pageB).getByTestId('document-comment-thread')).toHaveCount(2, { timeout: 10_000 })

    // Bob's attempt to change the text is refused: his editor takes no input, and nothing reaches Alice.
    const before = await text(pageB)
    await editor(pageB).locator('.cm-line', { hasText: 'First line.' }).first().click()
    await pageB.keyboard.type(' Bob rewrote this.')
    expect(await text(pageB)).toBe(before)
    await pageB.waitForTimeout(1_000)
    expect(await text(pageA)).not.toContain('Bob rewrote this.')
    expect(await fs.readFile(path.join(a.host.root, 'Notes.md'), 'utf8')).not.toContain('Bob rewrote this.')

    // Alice sees Bob among the people with access, as a commenter, and makes him a viewer.
    await openShareDialog(pageA, 'Notes')
    const bobRow = pageA.getByTestId('collab-member').filter({ hasText: 'Bob' })
    await expect(bobRow).toHaveAttribute('data-role', 'commenter', { timeout: 15_000 })
    await expect(pageA.getByTestId('collab-member').filter({ hasText: 'Alice' })).toHaveAttribute('data-role', 'owner')
    await bobRow.getByTestId('collab-member-role').selectOption('viewer')
    await expect(bobRow).toHaveAttribute('data-role', 'viewer', { timeout: 15_000 })
    await expect(tabs(pageB).getByTestId('collab-view-only')).toBeVisible({ timeout: 15_000 })
    // A viewer reads the comments but writes none.
    await expect(comments(pageB).getByTestId('document-comments-new')).toHaveCount(0)
    await expect(comments(pageB).getByTestId('document-comment-reply-input')).toHaveCount(0)

    // Alice removes him: he leaves the room, and his copy stays his, no longer co-edited.
    await bobRow.getByTestId('collab-member-remove').click()
    await expect(pageA.getByTestId('collab-member').filter({ hasText: 'Bob' })).toHaveCount(0, { timeout: 15_000 })
    await expect(tabs(pageB).getByTestId('collab-status')).toHaveCount(0, { timeout: 15_000 })
    await expect(tabs(pageA).getByTestId('collab-peer')).toHaveCount(0, { timeout: 15_000 })
    await pageA.screenshot({ path: testInfo.outputPath('alice-members.png') })
    await pageA.keyboard.press('Escape')

    // Without co-editing, Alice's thread in Bob's copy is read-only history; his own is still his.
    await expect(editor(pageB)).not.toHaveAttribute('aria-readonly', 'true', { timeout: 15_000 })
    await expect(comments(pageB).getByTestId('document-comments-new')).toBeVisible({ timeout: 15_000 })
    const threadsB = comments(pageB).getByTestId('document-comment-thread')
    const alicesThread = threadsB.filter({ hasText: 'Alice’s own note.' })
    await expect(alicesThread.getByTestId('document-comment-history')).toBeVisible()
    await expect(alicesThread.getByTestId('document-comment-resolve')).toHaveCount(0)
    await expect(alicesThread.getByTestId('document-comment-reply-input')).toHaveCount(0)
    const bobsThread = threadsB.filter({ hasText: 'Should this say more?' })
    await expect(bobsThread.getByTestId('document-comment-history')).toHaveCount(0)
    await expect(bobsThread.getByTestId('document-comment-resolve')).toBeVisible()
    await commentOn(pageB, 'First line.', 'A note for myself.')
    await expect(threadsB).toHaveCount(3)
    // Alice does not get it any more.
    await pageB.waitForTimeout(1_000)
    await expect(comments(pageA).getByTestId('document-comment-thread')).toHaveCount(2)
    // Bob deletes only what he wrote.
    await expect(comments(pageB).getByTestId('document-comment-delete')).toHaveCount(2)
    await pageB.screenshot({ path: testInfo.outputPath('bob-removed.png') })
    expect(await fs.readFile(path.join(b.host.root, 'Shared', 'Notes.md'), 'utf8')).toBe(NOTES)
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})
