import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import {
  DEV_PRINCIPALS,
  kitionProSkipReason,
  kitPackageHasReplicaInfo,
  openSharedLink,
  openTabMenu,
  recordWebSockets,
  replicaCounters,
  shareFromTab,
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

type NodeWordDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ WordDocument: { create(name: string, width: number, height: number): NodeWordDocument } }>('word', 'kition_word_sdk')

/** A letter made by the same engine the page runs: a title paragraph and a body paragraph. */
async function letterFixture() {
  const sdk = await engine.load()
  const doc = sdk.WordDocument.create('Field Notes.docx', 612, 792)
  doc.execute('para.style', JSON.stringify({ style: 'Title' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Field notes' }))
  doc.execute('text.newParagraph', '{}')
  doc.execute('para.style', JSON.stringify({ style: 'Normal' }))
  doc.execute('text.insert', JSON.stringify({ text: 'Auroras appear near the poles.' }))
  doc.execute('caret.docStart', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const canvas = (kit: FrameLocator) => kit.getByTestId('word-canvas-region').screenshot()

/**
 * The replica version at `path` once it stops changing: typing streams one small transaction per
 * keystroke rather than committing as a single step, so the version a moment after the last key
 * is not necessarily the final one.
 */
async function settledVersion(page: Page, path: string) {
  let previous: string | null = null
  await expect
    .poll(async () => {
      const next = JSON.stringify(await replicaCounters(page, path))
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous as string
}

/** Places the caret at the very start of the document (the title paragraph) and types `text`. */
async function typeAtDocStart(page: Page, kit: FrameLocator, text: string) {
  await kit.getByTestId('word-canvas-region').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.type(text)
}

/** Places the caret at the very end of the document (the body paragraph) and types `text`. */
async function typeAtDocEnd(page: Page, kit: FrameLocator, text: string) {
  await kit.getByTestId('word-canvas-region').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(text)
}

test('co-edits a Word document between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Word kit editor is not built into public/kits/word-ui')
  test.skip(!kitPackageHasReplicaInfo('word', 'kition_word_sdk'), 'the Word kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh word')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her letter and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Field Notes.docx', await letterFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Field Notes')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the letter is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Field Notes.docx'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx')), { timeout: 15_000 }).toBe(JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx')))

    // Alice types into the title paragraph: within a second Bob's canvas shows it.
    const bobBeforeTitle = await canvas(kitB)
    const titleBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx'))
    await typeAtDocStart(pageA, a.kit, 'Updated: ')
    const typedTitle = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx')), { intervals: [10] }).not.toBe(titleBaseline)
    const aliceTitleVersion = await settledVersion(pageA, 'Field Notes.docx')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx')), { timeout: 5_000, intervals: [20] }).toBe(aliceTitleVersion)
    const titleLive = Date.now() - typedTitle
    testInfo.annotations.push({ type: 'live title edit to the other window', description: `${titleLive} ms` })
    expect(titleLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(kitB)).equals(bobBeforeTitle), { timeout: 5_000 }).toBe(false)

    // Bob types into the body paragraph: within a second Alice's canvas shows it too.
    const aliceBeforeBody = await canvas(a.kit)
    const bodyBaseline = JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx'))
    await typeAtDocEnd(pageB, kitB, ' Bob was here.')
    const typedBody = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx')), { intervals: [10] }).not.toBe(bodyBaseline)
    const bobBodyVersion = await settledVersion(pageB, 'Shared/Field Notes.docx')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx')), { timeout: 5_000, intervals: [20] }).toBe(bobBodyVersion)
    const bodyLive = Date.now() - typedBody
    testInfo.annotations.push({ type: 'live body edit to the other window', description: `${bodyLive} ms` })
    expect(bodyLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(a.kit)).equals(aliceBeforeBody), { timeout: 5_000 }).toBe(false)

    // Bob goes offline and edits the title; Alice edits the body, meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx'))
    await typeAtDocStart(pageB, kitB, 'Offline: ')
    await typeAtDocEnd(pageA, a.kit, ' Alice too.')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx'))).not.toBe(offlineVersion)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx')))

    // Back online, both merge on their own: the same replica, with both offline edits.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Field Notes.docx')), { timeout: 60_000 }).toBe(JSON.stringify(await replicaCounters(pageA, 'Field Notes.docx')))
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Word document opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Word kit editor is not built into public/kits/word-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Field Notes.docx', await letterFixture())
  try {
    await expect(kit.getByTestId('word-status')).toHaveText('Page 1 of 1', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Field Notes', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await typeAtDocEnd(page, kit, ' Solo edit.')
    await expect(kit.getByTestId('word-unsaved')).toBeVisible()
    await kit.getByTestId('word-save').click()
    await expect(kit.getByTestId('word-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Field Notes.docx'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
