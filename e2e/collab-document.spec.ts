import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'
import {
  DEV_PRINCIPALS,
  kitionProSkipReason,
  openSharedLink,
  openTabMenu,
  recordWebSockets,
  shareFromTab,
  shareViewOnlyFromTab,
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

// Co-editing a Markdown document between two windows through the Kition Pro sync server: typing
// in one shows in the other within a second, text typed while one window was offline merges
// character by character when it is back, a viewer cannot type, and without Kition Pro nothing
// changes.

const NOTES = '# Launch notes\n\nFirst line.\n'

function editor(page: Page) {
  return page.getByTestId('document-editor').locator('.cm-content').first()
}

async function openNotes(page: Page) {
  await page.locator('.document-tree-row', { hasText: 'Notes' }).first().click()
  await expect(editor(page)).toBeVisible({ timeout: 30_000 })
}

/** Types `text` at the end of the line showing `line`. */
async function typeAfter(page: Page, line: string, text: string) {
  await editor(page).locator('.cm-line', { hasText: line }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

const text = (page: Page) => editor(page).innerText()
const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

test('co-edits a Markdown document between two windows: live, and merging text typed offline', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openKitWorkspace(pageA, baseURL!, { 'Notes.md': Buffer.from(NOTES) }, signedIn(DEV_PRINCIPALS.alice))
    await openNotes(pageA)
    const link = await shareFromTab(pageA, 'Notes')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: Shared/Notes.md, with the same text.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    await expect(editor(pageB)).toContainText('First line.', { timeout: 30_000 })
    await expect.poll(() => existsSync(path.join(b.host.root, 'Shared', 'Notes.md')), { timeout: 10_000 }).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })

    // Alice types: within a second it shows in Bob's editor, and Bob's file gets it too.
    await typeAfter(pageA, 'First line.', ' Alice was here.')
    const typed = Date.now()
    await expect.poll(() => text(pageB), { timeout: 5_000, intervals: [20] }).toContain('Alice was here.')
    const live = Date.now() - typed
    testInfo.annotations.push({ type: 'live edit to the other window', description: `${live} ms` })
    expect(live).toBeLessThan(1_000)
    await expect.poll(() => fs.readFile(path.join(b.host.root, 'Shared', 'Notes.md'), 'utf8'), { timeout: 10_000 }).toContain('Alice was here.')
    // Bob's undo does not take back Alice's typing: the merge is no undo step of his.
    await editor(pageB).click()
    await pageB.keyboard.press('ControlOrMeta+z')
    expect(await text(pageB)).toContain('Alice was here.')

    // Bob goes offline and types in the heading; Alice types at the end meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await typeAfter(pageB, 'Launch notes', ' (draft)')
    await typeAfter(pageA, 'Alice was here.', ' Still here.')
    expect(await text(pageA)).not.toContain('(draft)')

    // Back online: both have both edits, merged in place.
    await bobNetwork.setOnline(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    for (const page of [pageA, pageB]) {
      await expect.poll(() => text(page), { timeout: 60_000 }).toContain('Launch notes (draft)')
      await expect.poll(() => text(page), { timeout: 60_000 }).toContain('Alice was here. Still here.')
    }
    await expect.poll(() => fs.readFile(path.join(a.host.root, 'Notes.md'), 'utf8'), { timeout: 10_000 }).toContain('(draft)')
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('a viewer of a shared Markdown document reads it as it changes but cannot type', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(240_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    await openKitWorkspace(pageA, baseURL!, { 'Notes.md': Buffer.from(NOTES) }, signedIn(DEV_PRINCIPALS.alice))
    await openNotes(pageA)
    const { viewLink } = await shareViewOnlyFromTab(pageA, 'Notes')

    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, viewLink)
    await expect(editor(pageB)).toContainText('First line.', { timeout: 30_000 })
    await expect(pageB.locator('.document-tab-list [data-testid="collab-view-only"]')).toBeVisible({ timeout: 15_000 })
    await expect(editor(pageB)).toHaveAttribute('contenteditable', 'false', { timeout: 15_000 })
    const before = await text(pageB)
    await editor(pageB).locator('.cm-line', { hasText: 'First line.' }).first().click()
    await pageB.keyboard.type(' Bob tried.')
    expect(await text(pageB)).toBe(before)

    // Alice's typing still reaches the viewer, and his copy of the file.
    await typeAfter(pageA, 'First line.', ' Seen by Bob.')
    await expect.poll(() => text(pageB), { timeout: 10_000 }).toContain('Seen by Bob.')
    await expect.poll(() => fs.readFile(path.join(b.host.root, 'Shared', 'Notes.md'), 'utf8'), { timeout: 10_000 }).toContain('Seen by Bob.')
    expect(await text(pageA)).not.toContain('Bob tried.')
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Markdown document edits and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host } = await openKitWorkspace(page, baseURL!, { 'Notes.md': Buffer.from(NOTES) })
  try {
    await openNotes(page)
    await openTabMenu(page, 'Notes', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await typeAfter(page, 'First line.', ' Saved alone.')
    await expect.poll(() => fs.readFile(path.join(host.root, 'Notes.md'), 'utf8'), { timeout: 10_000 }).toContain('Saved alone.')
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
