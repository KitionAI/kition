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
  shareViewOnlyFromTab,
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

type NodeSlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{
  SlideDocument: { create(name: string, width: number, height: number): NodeSlideDocument; open(name: string, bytes: Uint8Array): NodeSlideDocument }
}>('slide', 'kition_slide_sdk')

/** A deck made by the same engine the page runs: slide 1 is a full-slide text box, slide 2 a square. */
async function deckFixture() {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.create('Keynote.kitionslide', 960, 540)
  // The first slide's layout placeholders go: the text box is its lone shape, across the slide's
  // middle, where a click selects it (else the empty title placeholder there takes the click).
  doc.execute('edit.selectAll', '{}')
  doc.execute('edit.delete', '{}')
  doc.execute('insert.textBox', JSON.stringify({ rect: [0, 255, 960, 30], text: 'Hello' }))
  doc.execute('slide.new', '{}')
  doc.execute('shape.insert', JSON.stringify({ preset: 'rect', rect: [380, 170, 200, 200] }))
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** 'same' once both windows' replicas are at the same version, else both versions. Both are read
 * on every poll: after a reconnect each side is still taking the other's changes. */
async function sameReplica(pageA: Page, pathA: string, pageB: Page, pathB: string) {
  const [a, b] = await Promise.all([replicaCounters(pageA, pathA), replicaCounters(pageB, pathB)])
  return JSON.stringify(a) === JSON.stringify(b) ? 'same' : `${JSON.stringify(a)} / ${JSON.stringify(b)}`
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
/** The kit's canvas as drawn. Kition's floating agent launcher sits over the canvas's corner and
 * idles with an animation, so it is masked: it is the host's, not the kit's. */
const canvas = (kit: FrameLocator) =>
  kit.getByTestId('slides-canvas-region').screenshot({
    animations: 'disabled',
    mask: [kit.owner().page().getByTestId('agent-floating-launcher')],
  })

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

/** Clicks the lone text box on the current slide (a text box takes text on the first click: the
 * caret goes where the click is) and types `text` there. */
async function typeIntoShape(page: Page, kit: FrameLocator, text: string) {
  const region = (await kit.getByTestId('slides-canvas-region').boundingBox())!
  await page.mouse.click(region.x + region.width / 2, region.y + region.height / 2)
  await expect(kit.locator('[data-testid="kit-text-sink"]')).toBeFocused({ timeout: 10_000 })
  await page.keyboard.type(text)
}

test('co-edits a Slides deck between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Slides kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slides kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her deck and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Keynote.kitionslide', await deckFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Keynote')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the deck is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Keynote.kitionslide'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide')), { timeout: 15_000 }).toBe(JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide')))

    // Alice edits the text box's text: within a second Bob's canvas shows it.
    const bobBeforeText = await canvas(kitB)
    const textBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide'))
    await typeIntoShape(pageA, a.kit, 'Launch day')
    const typed = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide')), { intervals: [10] }).not.toBe(textBaseline)
    const aliceTextVersion = await settledVersion(pageA, 'Keynote.kitionslide')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide')), { timeout: 5_000, intervals: [20] }).toBe(aliceTextVersion)
    const textLive = Date.now() - typed
    testInfo.annotations.push({ type: 'live text edit to the other window', description: `${textLive} ms` })
    expect(textLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(kitB)).equals(bobBeforeText), { timeout: 5_000 }).toBe(false)

    // Alice drags slide 2 onto slide 1: Bob's status follows the text slide he is viewing, which
    // moved from position 1 to position 2 (collaborators follow a slide's identity, not its index).
    const moveBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide'))
    await a.kit.getByTestId('slides-slide-1').dragTo(a.kit.getByTestId('slides-slide-0'))
    const moved = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide')), { intervals: [10] }).not.toBe(moveBaseline)
    const aliceMoveVersion = await settledVersion(pageA, 'Keynote.kitionslide')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide')), { timeout: 5_000, intervals: [20] }).toBe(aliceMoveVersion)
    const moveLive = Date.now() - moved
    testInfo.annotations.push({ type: 'live slide move to the other window', description: `${moveLive} ms` })
    expect(moveLive).toBeLessThan(1_000)
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 2 of 2')

    // Bob goes offline and adds a slide; Alice adds one too, meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide'))
    await kitB.getByTestId('slides-add-slide').click()
    await expect(kitB.getByTestId('slides-status')).toHaveText(/of 3$/)
    await a.kit.getByTestId('slides-add-slide').click()
    await expect(a.kit.getByTestId('slides-status')).toHaveText(/of 3$/)
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide'))).not.toBe(offlineVersion)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Keynote.kitionslide'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide')))

    // Back online, both merge on their own: the same replica, with both added slides.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplica(pageA, 'Keynote.kitionslide', pageB, 'Shared/Keynote.kitionslide'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(a.kit.getByTestId('slides-status')).toHaveText(/of 4$/)
    await expect(kitB.getByTestId('slides-status')).toHaveText(/of 4$/)
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

/** The text of the first slide's text box in a saved deck, read by the same engine. */
async function savedText(deck: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.open('Saved.kitionslide', deck)
  doc.execute('slide.go', JSON.stringify({ index: 0 }))
  doc.execute('edit.selectAll', '{}')
  const { text } = JSON.parse(doc.execute('text.get', '{}')) as { text: string }
  doc.free()
  return text
}

/** Clicks the lone text box on the current slide, which puts the caret in its text at once (a text
 * box takes text on the first click, as in PowerPoint; Enter would then break the line), moves the
 * caret with `key` (End: the line's end, Home: its start), and types `text`. */
async function typeInShapeText(page: Page, kit: FrameLocator, text: string, key: 'End' | 'Home' = 'End') {
  const region = (await kit.getByTestId('slides-canvas-region').boundingBox())!
  await page.mouse.click(region.x + region.width / 2, region.y + region.height / 2)
  await expect(kit.locator('[data-testid="kit-text-sink"]')).toBeFocused({ timeout: 10_000 })
  await page.keyboard.press(key)
  await page.keyboard.type(text)
}

test('two windows typing into one text box at once keep both texts', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Slides kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slides kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
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
    const a = await openInKitFrame(pageA, baseURL!, 'Keynote.kitionslide', await deckFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Keynote')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    const converged = async () =>
      expect.poll(() => sameReplica(pageA, 'Keynote.kitionslide', pageB, 'Shared/Keynote.kitionslide'), { timeout: 60_000 }).toBe('same')
    await converged()

    // At once (Bob offline): Alice types at the end of the "Hello" text box, Bob at its start.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await typeInShapeText(pageA, a.kit, ' from Alice')
    await typeInShapeText(pageB, kitB, 'Bob says ', 'Home')
    await settledVersion(pageA, 'Keynote.kitionslide')
    await settledVersion(pageB, 'Shared/Keynote.kitionslide')
    await bobNetwork.setOnline(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await converged()

    // Alice saves: the text box holds both texts.
    await pageA.keyboard.press('Escape')
    const saved = a.saves.length
    await a.kit.getByTestId('slides-save').click()
    await expect.poll(() => a.saves.length, { timeout: 30_000 }).toBeGreaterThan(saved)
    expect(await savedText(a.saves[a.saves.length - 1].bytes)).toBe('Bob says Hello from Alice')
    await pageA.screenshot({ path: testInfo.outputPath('alice-one-text-box.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob-one-text-box.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('a viewer of a shared Slides deck sees it change but cannot change it', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Slides kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slides kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Keynote.kitionslide', await deckFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    const { viewLink } = await shareViewOnlyFromTab(pageA, 'Keynote')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the view-only link: the deck opens read-only, with no Save, Undo, or Redo.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, viewLink)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await expect(pageB.locator('.document-tab-list [data-testid="collab-view-only"]')).toBeVisible({ timeout: 15_000 })
    await expect(kitB.getByTestId('slides-view-only')).toBeVisible({ timeout: 15_000 })
    await expect(kitB.getByTestId('slides-save')).toHaveCount(0)
    await expect(kitB.getByTestId('slides-undo')).toHaveCount(0)
    await expect(kitB.getByTestId('slides-cmd-slide.new')).toBeDisabled()
    const bobPath = 'Shared/Keynote.kitionslide'
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, bobPath)), { timeout: 15_000 }).toBe(JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide')))

    // Alice edits the text box's text: Bob's canvas shows it.
    const bobBeforeText = await canvas(kitB)
    await typeIntoShape(pageA, a.kit, 'Launch day')
    const aliceVersion = await settledVersion(pageA, 'Keynote.kitionslide')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, bobPath)), { timeout: 10_000 }).toBe(aliceVersion)
    await expect.poll(async () => (await canvas(kitB)).equals(bobBeforeText), { timeout: 5_000 }).toBe(false)
    // A viewer has nothing to save: Alice's edits never mark his deck unsaved.
    await expect(kitB.getByTestId('slides-unsaved')).toHaveCount(0)

    // Bob clicks the text box and types and presses New Slide's shortcut: his screen and his
    // replica stay as they were. The slide panel's add button is disabled for him.
    // What his canvas shows once Alice's edit has painted.
    let shown = await canvas(kitB)
    await expect
      .poll(async () => {
        const next = await canvas(kitB)
        const same = next.equals(shown)
        shown = next
        return same
      }, { timeout: 10_000, intervals: [200] })
      .toBe(true)
    const region = (await kitB.getByTestId('slides-canvas-region').boundingBox())!
    await pageB.mouse.click(region.x + region.width / 2, region.y + region.height / 2)
    await pageB.keyboard.type('Bob was here')
    await pageB.keyboard.press('ControlOrMeta+Shift+N')
    await pageB.waitForTimeout(500)
    const after = await canvas(kitB)
    expect(after.equals(shown)).toBe(true)
    await expect(kitB.getByTestId('slides-add-slide')).toBeDisabled()
    await kitB.getByTestId('slides-add-slide').click({ force: true })
    await pageB.waitForTimeout(1_000)
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 2')
    expect(JSON.stringify(await replicaCounters(pageB, bobPath))).toBe(aliceVersion)
    expect(JSON.stringify(await replicaCounters(pageA, 'Keynote.kitionslide'))).toBe(aliceVersion)

    // Viewing still works: Bob moves to the next slide.
    await kitB.getByTestId('slides-slide-1').click()
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 2 of 2')
    expect(JSON.stringify(await replicaCounters(pageB, bobPath))).toBe(aliceVersion)

    // Alice's next edit still reaches him.
    await a.kit.getByTestId('slides-add-slide').click()
    await expect(a.kit.getByTestId('slides-status')).toHaveText(/of 3$/)
    await expect(kitB.getByTestId('slides-status')).toHaveText(/of 3$/, { timeout: 10_000 })
    await pageB.screenshot({ path: testInfo.outputPath('bob-viewer.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Slides deck opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Slides kit editor is not built into public/kits/slide-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Keynote.kitionslide', await deckFixture())
  try {
    await expect(kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Keynote', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await kit.getByTestId('slides-add-slide').click()
    await expect(kit.getByTestId('slides-status')).toHaveText(/of 3$/)
    await expect(kit.getByTestId('slides-unsaved')).toBeVisible()
    await kit.getByTestId('slides-save').click()
    await expect(kit.getByTestId('slides-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Keynote.kitionslide'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
