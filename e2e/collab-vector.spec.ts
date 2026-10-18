import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

type NodeVectorDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ VectorDocument: { create(name: string, width: number, height: number): NodeVectorDocument } }>('vector', 'kition_vector_sdk')

/** A drawing made by the same engine the page runs: two tall rectangles, one on each half. */
async function drawingFixture() {
  const sdk = await engine.load()
  const doc = sdk.VectorDocument.create('Poster.kitionvector', 400, 300)
  doc.execute('shape.rectangle', JSON.stringify({ x: 20, y: 20, width: 170, height: 260 }))
  doc.execute('shape.rectangle', JSON.stringify({ x: 210, y: 20, width: 170, height: 260 }))
  doc.execute('select.none', '{}')
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const canvas = (kit: FrameLocator) => kit.getByTestId('vector-canvas-region').screenshot()

/** The point at (`x`, `y`), fractions of the canvas region, in page coordinates. */
async function at(kit: FrameLocator, x: number, y: number) {
  const region = (await kit.getByTestId('vector-canvas-region').boundingBox())!
  return { x: region.x + region.width * x, y: region.y + region.height * y }
}

/** Drags the object under (`x`, `y`) by `dx` pixels with the Selection tool. */
async function moveObject(page: Page, kit: FrameLocator, x: number, y: number, dx: number) {
  await kit.getByTestId('vector-tool-selection').click()
  const from = await at(kit, x, y)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y, { steps: 6 })
  await page.mouse.up()
}

/** Selects the object under (`x`, `y`) and gives it `color` from the Appearance panel. */
async function recolor(page: Page, kit: FrameLocator, x: number, y: number, color: string) {
  await kit.getByTestId('vector-tool-selection').click()
  const point = await at(kit, x, y)
  await page.mouse.click(point.x, point.y)
  await expect(kit.getByTestId('vector-selection-size')).toBeVisible({ timeout: 10_000 })
  await kit.getByTestId('vector-fill').fill(color)
}

/** Draws a small rectangle with the Rectangle tool from (`x`, `y`). */
async function drawRectangle(page: Page, kit: FrameLocator, x: number, y: number) {
  await kit.getByTestId('vector-tool-rectangle').click()
  const from = await at(kit, x, y)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 30, from.y + 24, { steps: 5 })
  await page.mouse.up()
}

/** The replica version at `path` once it stops changing (a drag commits as one step, but the
 * Appearance panel's colour field may apply more than one value). */
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
  return (previous as string | null) ?? ''
}

test('co-edits a Vector drawing between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.skip(!kitPackageHasReplicaInfo('vector', 'kition_vector_sdk'), 'the Vector kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh vector')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her drawing and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Poster.kitionvector', await drawingFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('vector-status')).toContainText('2 objects', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Poster')
    expect(link).toMatch(/\/s\/\S+$/)
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the drawing is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('vector-status')).toContainText('2 objects', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Poster.kitionvector'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Poster.kitionvector', pageB, 'Shared/Poster.kitionvector'), { timeout: 15_000 }).toBe('same')

    // Alice moves the left rectangle: within a second Bob's replica has the move, and his canvas shows it.
    const bobBeforeMove = await canvas(kitB)
    const moveBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.kitionvector'))
    await moveObject(pageA, a.kit, 0.3, 0.5, 30)
    const moved = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector')), { intervals: [10] }).not.toBe(moveBaseline)
    const aliceMoveVersion = await settledVersion(pageA, 'Poster.kitionvector')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.kitionvector')), { timeout: 5_000, intervals: [20] }).toBe(aliceMoveVersion)
    const moveLive = Date.now() - moved
    testInfo.annotations.push({ type: 'live move to the other window', description: `${moveLive} ms` })
    expect(moveLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(kitB)).equals(bobBeforeMove), { timeout: 5_000 }).toBe(false)

    // Bob recolours the right rectangle: within a second Alice's replica and canvas have it.
    const aliceBeforeColor = await canvas(a.kit)
    const colorBaseline = JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector'))
    await recolor(pageB, kitB, 0.7, 0.5, '#d02020')
    const recoloured = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.kitionvector')), { intervals: [10] }).not.toBe(colorBaseline)
    const bobColorVersion = await settledVersion(pageB, 'Shared/Poster.kitionvector')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector')), { timeout: 5_000, intervals: [20] }).toBe(bobColorVersion)
    const colorLive = Date.now() - recoloured
    testInfo.annotations.push({ type: 'live recolour to the other window', description: `${colorLive} ms` })
    expect(colorLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(a.kit)).equals(aliceBeforeColor), { timeout: 5_000 }).toBe(false)

    // Bob goes offline and draws a rectangle; Alice draws one too, meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector'))
    await drawRectangle(pageB, kitB, 0.6, 0.2)
    await expect(kitB.getByTestId('vector-status')).toContainText('3 objects')
    await drawRectangle(pageA, a.kit, 0.2, 0.7)
    await expect(a.kit.getByTestId('vector-status')).toContainText('3 objects')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector'))).not.toBe(offlineVersion)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.kitionvector'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Poster.kitionvector')))

    // Back online, both merge on their own: the same replica, with both new rectangles.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Poster.kitionvector', pageB, 'Shared/Poster.kitionvector'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(a.kit.getByTestId('vector-status')).toContainText('4 objects')
    await expect(kitB.getByTestId('vector-status')).toContainText('4 objects')
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Vector drawing opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Vector kit editor is not built into public/kits/vector-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.kitionvector', await drawingFixture())
  try {
    await expect(kit.getByTestId('vector-status')).toContainText('2 objects', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Poster', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await drawRectangle(page, kit, 0.5, 0.4)
    await expect(kit.getByTestId('vector-status')).toContainText('3 objects')
    await expect(kit.getByTestId('vector-unsaved')).toBeVisible()
    await kit.getByTestId('vector-save').click()
    await expect(kit.getByTestId('vector-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Poster.kitionvector'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
