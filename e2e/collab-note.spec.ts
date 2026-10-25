import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, openSharedLink, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'
import { caretAfter, noteText, openNote, requireNoteKit } from './helpers/noteKit'

/**
 * A note co-edited between two windows through Kition's sync server: the Note kit's replica (the
 * note's text and its comment threads) relays live, and text typed offline merges when the window
 * is back online.
 */

const NOTE = '# Plan\n\nGoals for the quarter.\n\nClosing words.\n'
const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/** Types `text` at the end of the line holding `line`. */
async function typeAfter(page: Page, kit: FrameLocator, line: string, text: string) {
  await caretAfter(page, kit, line)
  await page.keyboard.type(text)
}

test('co-edits a note between two windows: live text and comments, and merging text typed offline', async ({ browser, baseURL }, testInfo) => {
  requireNoteKit()
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her note and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openNote(pageA, baseURL!, 'Plan.md', NOTE, {}, signedIn(DEV_PRINCIPALS.alice))
    const link = await shareFromTab(pageA, 'Plan')
    expect(link).toMatch(/\/s\/\S+$/)
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the note is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await pageB.addInitScript(() => window.localStorage.setItem('kit.note.autosave', 'off'))
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('note-text')).toContainText('Goals for the quarter.', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Plan.md'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Plan.md', pageB, 'Shared/Plan.md'), { timeout: 15_000 }).toBe('same')

    // Alice types: Bob's note has it within seconds; Bob types back.
    await typeAfter(pageA, a.kit, 'Goals for the quarter.', ' From Alice.')
    await expect.poll(() => noteText(pageB), { timeout: 10_000 }).toContain('Goals for the quarter. From Alice.')
    await typeAfter(pageB, kitB, 'Closing words.', ' From Bob.')
    await expect.poll(() => noteText(pageA), { timeout: 10_000 }).toContain('Closing words. From Bob.')

    // A comment is part of the shared note: Bob sees Alice's thread.
    await caretAfter(pageA, a.kit, 'Goals', { select: true })
    await a.kit.getByTestId('note-comments-toggle').click()
    await a.kit.getByTestId('note-comments-new').click()
    await a.kit.getByTestId('note-comment-panel-new-input').fill('Which quarter?')
    await a.kit.getByTestId('note-comment-panel-new-send').click()
    await expect(a.kit.getByTestId('note-comments-count')).toHaveText('1')
    await expect(kitB.getByTestId('note-comments-count')).toHaveText('1', { timeout: 10_000 })

    // Bob goes offline and types; Alice types too, meanwhile; back online, both texts are kept.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await typeAfter(pageB, kitB, 'Closing words. From Bob.', ' Offline.')
    await typeAfter(pageA, a.kit, 'Goals for the quarter. From Alice.', ' Meanwhile.')
    await bobNetwork.setOnline(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const merged = '# Plan\n\nGoals for the quarter. From Alice. Meanwhile.\n\nClosing words. From Bob. Offline.\n'
    await expect.poll(() => noteText(pageA), { timeout: 30_000 }).toBe(merged)
    await expect.poll(() => noteText(pageB), { timeout: 30_000 }).toBe(merged)
    await expect.poll(() => sameReplicas(pageA, 'Plan.md', pageB, 'Shared/Plan.md'), { timeout: 15_000 }).toBe('same')
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})
