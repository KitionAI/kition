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

type NodePdfDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ PdfDocument: { create(name: string, width: number, height: number): NodePdfDocument } }>('pdf', 'kition_pdf_sdk')

/** A PDF made by the same engine the page runs: two pages of text, and a text field `Name` on the first. */
async function formFixture() {
  const sdk = await engine.load()
  const doc = sdk.PdfDocument.create('Form.pdf', 612, 792)
  doc.execute('page_add_text', JSON.stringify({ page: 1, text: 'Field guide', at: [72, 90], size: 24, width: 468 }))
  doc.execute('page_insert_blank', JSON.stringify({ at: 2 }))
  doc.execute('page_add_text', JSON.stringify({ page: 2, text: 'Green comes from oxygen.', at: [72, 90], size: 12, width: 468 }))
  doc.execute('form_add_field', JSON.stringify({ page: 1, type: 'text', rect: [72, 600, 300, 624], name: 'Name' }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/** The replica version at `path` as counters, as a string to compare. */
const counters = async (page: Page, path: string) => JSON.stringify(await replicaCounters(page, path))

/** The version at `path` once it stops changing (a command can settle in more than one transaction). */
async function settledVersion(page: Page, path: string) {
  let previous: string | null = null
  await expect
    .poll(async () => {
      const next = await counters(page, path)
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous ?? ''
}

/** Adds a sticky note saying `text` on page `page` (1-based) through the Home tab's dialog. */
async function addNote(kit: FrameLocator, page: number, text: string) {
  await kit.getByTestId('ribbon-tab-home').click()
  await kit.getByTestId('pdf-sticky-note').click()
  await kit.locator('#param-page').fill(String(page))
  await kit.locator('#param-contents').fill(text)
  await kit.getByTestId('command-dialog-run').click()
  await expect(kit.getByTestId('command-dialog-run')).toHaveCount(0)
}

/** Fills the `Name` field from the form fields panel (Enter commits it). */
async function fillName(kit: FrameLocator, value: string) {
  await kit.getByTestId('pdf-panel-fields').click()
  const field = kit.getByTestId('pdf-field-Name')
  await field.fill(value)
  await field.press('Enter')
}

/** The `Name` field's value as the fields panel shows it (opened afresh, so it reads the document as it is now). */
async function nameValue(kit: FrameLocator) {
  await kit.getByTestId('pdf-panel-pages').click()
  await kit.getByTestId('pdf-panel-fields').click()
  return kit.getByTestId('pdf-field-Name').inputValue()
}

/** The comments the comments panel lists. */
async function commentTexts(kit: FrameLocator) {
  await kit.getByTestId('pdf-panel-comments').click()
  return kit.getByTestId('pdf-comment').allInnerTexts()
}

test('co-edits a PDF between two windows: a comment and a form fill live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the PDF kit editor is not built into public/kits/pdf-ui')
  test.skip(!kitPackageHasReplicaInfo('pdf', 'kition_pdf_sdk'), 'the PDF kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh pdf')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her form and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Form.pdf', await formFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Form')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the PDF is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Form.pdf'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => counters(pageB, 'Shared/Form.pdf'), { timeout: 15_000 }).toBe(await counters(pageA, 'Form.pdf'))

    // Alice adds a comment: within a second Bob's replica has it, and his comments panel lists it.
    const commentBaseline = await counters(pageB, 'Shared/Form.pdf')
    await addNote(a.kit, 1, 'Please sign here')
    const commented = Date.now()
    await expect.poll(() => counters(pageA, 'Form.pdf'), { intervals: [10] }).not.toBe(commentBaseline)
    const aliceComment = await settledVersion(pageA, 'Form.pdf')
    await expect.poll(() => counters(pageB, 'Shared/Form.pdf'), { timeout: 5_000, intervals: [20] }).toBe(aliceComment)
    const commentLive = Date.now() - commented
    testInfo.annotations.push({ type: 'live comment to the other window', description: `${commentLive} ms` })
    expect(commentLive).toBeLessThan(1_000)
    await expect.poll(() => commentTexts(kitB), { timeout: 5_000 }).toEqual([expect.stringContaining('Please sign here')])

    // Bob fills the form field: within a second Alice's replica has it, and her field shows it.
    const fillBaseline = await counters(pageA, 'Form.pdf')
    await fillName(kitB, 'Bob')
    const filled = Date.now()
    await expect.poll(() => counters(pageB, 'Shared/Form.pdf'), { intervals: [10] }).not.toBe(fillBaseline)
    const bobFill = await settledVersion(pageB, 'Shared/Form.pdf')
    await expect.poll(() => counters(pageA, 'Form.pdf'), { timeout: 5_000, intervals: [20] }).toBe(bobFill)
    const fillLive = Date.now() - filled
    testInfo.annotations.push({ type: 'live form fill to the other window', description: `${fillLive} ms` })
    expect(fillLive).toBeLessThan(1_000)
    await expect.poll(() => nameValue(a.kit), { timeout: 5_000 }).toBe('Bob')

    // Bob goes offline and comments on page 2; Alice fills the field again, meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = await counters(pageA, 'Form.pdf')
    await addNote(kitB, 2, 'Check the colour')
    await expect.poll(() => commentTexts(kitB)).toHaveLength(2)
    await fillName(a.kit, 'Alice')
    await expect.poll(() => counters(pageA, 'Form.pdf')).not.toBe(offlineVersion)
    expect(await counters(pageB, 'Shared/Form.pdf')).not.toBe(await counters(pageA, 'Form.pdf'))

    // Back online, both merge on their own: the same replica, with both edits.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => counters(pageB, 'Shared/Form.pdf'), { timeout: 60_000 }).toBe(await counters(pageA, 'Form.pdf'))
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect.poll(() => commentTexts(a.kit), { timeout: 10_000 }).toHaveLength(2)
    await expect.poll(() => nameValue(kitB), { timeout: 10_000 }).toBe('Alice')
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a PDF opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the PDF kit editor is not built into public/kits/pdf-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Form.pdf', await formFixture())
  try {
    await expect(kit.getByTestId('pdf-status')).toHaveText('Page 1 of 2', { timeout: 60_000 })
    await openTabMenu(page, 'Form', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await kit.getByTestId('pdf-insert-page').click()
    await expect(kit.getByTestId('pdf-status')).toHaveText(/of 3$/)
    await expect(kit.getByTestId('pdf-unsaved')).toBeVisible()
    await kit.getByTestId('pdf-save').click()
    await expect(kit.getByTestId('pdf-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Form.pdf'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
