import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

type NodePhotoDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ PhotoDocument: { create(name: string, width: number, height: number): NodePhotoDocument } }>('photo', 'kition_photo_sdk')

async function posterFixture() {
  const sdk = await engine.load()
  const doc = sdk.PhotoDocument.create('Poster.psd', 480, 320)
  doc.execute('layer.new.layer', JSON.stringify({ name: 'Ink' }))
  const bytes = doc.save()
  doc.free()
  return Buffer.from(bytes)
}

/** A brush stroke across the canvas, starting at (`x`, `y`) as fractions of the canvas region. */
async function stroke(page: Page, kit: FrameLocator, x: number, y: number) {
  const region = (await kit.getByTestId('photo-canvas-region').boundingBox())!
  await page.mouse.move(region.x + region.width * x, region.y + region.height * y)
  await page.mouse.down()
  await page.mouse.move(region.x + region.width * x + 60, region.y + region.height * y + 24, { steps: 6 })
  await page.mouse.up()
}

const canvas = (kit: FrameLocator) => kit.getByTestId('photo-canvas-region').screenshot()
const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

test('co-edits a Photo document between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.skip(!kitPackageHasReplicaInfo('photo', 'kition_photo_sdk'), 'the Photo kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh photo')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her image and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Poster.psd', await posterFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Poster')
    expect(link).toMatch(/\/s\/\S+$/)
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the document is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Poster.psd'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect(pageB.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Alice')
    await expect.poll(() => sameReplicas(pageA, 'Poster.psd', pageB, 'Shared/Poster.psd'), { timeout: 15_000 }).toBe('same')

    // Alice paints: within a second Bob's replica has her stroke, and it shows on his canvas.
    const bobBefore = await canvas(kitB)
    const bobVersion = JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))
    await stroke(pageA, a.kit, 0.3, 0.4)
    // From the end of the stroke until Bob's replica holds everything Alice's does.
    const painted = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Poster.psd')), { intervals: [10] }).not.toBe(bobVersion)
    const aliceVersion = JSON.stringify(await replicaCounters(pageA, 'Poster.psd'))
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd')), { timeout: 5_000, intervals: [20] }).toBe(aliceVersion)
    const live = Date.now() - painted
    testInfo.annotations.push({ type: 'live edit to the other window', description: `${live} ms` })
    expect(live).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(kitB)).equals(bobBefore), { timeout: 5_000 }).toBe(false)

    // Bob goes offline and paints; Alice paints elsewhere meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = await replicaCounters(pageA, 'Poster.psd')
    await stroke(pageB, kitB, 0.65, 0.65)
    await stroke(pageA, a.kit, 0.15, 0.15)
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Poster.psd'))).not.toBe(JSON.stringify(offlineVersion))
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))).not.toBe(JSON.stringify(offlineVersion))
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Poster.psd')))
    const aliceOffline = await canvas(a.kit)

    // Back online, both merge on their own: the same replica, with both strokes.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Poster.psd', pageB, 'Shared/Poster.psd'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    const merged = await replicaCounters(pageA, 'Poster.psd')
    expect(Object.keys(merged).length).toBeGreaterThan(Object.keys(offlineVersion).length)
    await expect.poll(async () => (await canvas(a.kit)).equals(aliceOffline), { timeout: 5_000 }).toBe(false)
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

/** Whether the Photo kit package takes layer leases (its engine answers `layerObjectIds`). */
function photoPackageHasLeases() {
  const glue = path.join(process.cwd(), 'public', 'kits', 'photo-ui', 'engine', 'kition_photo_sdk.js')
  return existsSync(glue) && readFileSync(glue, 'utf8').includes('layerObjectIds')
}

test('a layer one window paints is locked in the other until its painter lets it go', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.skip(!photoPackageHasLeases(), 'the Photo kit package predates layer leases; build it locally with scripts/build-kit-ui.sh photo')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Poster.psd', await posterFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Poster')
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Poster.psd', pageB, 'Shared/Poster.psd'), { timeout: 15_000 }).toBe('same')
    const leaseOnBobsSide = kitB.locator('[data-testid^="photo-layer-lease-"]')
    await expect(leaseOnBobsSide).toHaveCount(0)

    // Alice presses on the canvas with the brush and keeps painting: she holds the layer's lease.
    const region = (await a.kit.getByTestId('photo-canvas-region').boundingBox())!
    await pageA.mouse.move(region.x + region.width * 0.3, region.y + region.height * 0.4)
    await pageA.mouse.down()
    await pageA.mouse.move(region.x + region.width * 0.35, region.y + region.height * 0.45, { steps: 4 })
    // Bob sees the layer locked, with who paints it.
    await expect(leaseOnBobsSide).toHaveAttribute('data-holder', 'Alice', { timeout: 10_000 })
    await pageB.screenshot({ path: testInfo.outputPath('bob-locked.png') })

    // Bob's stroke on that layer is refused, saying who paints it: nothing reaches either replica.
    const before = JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))
    await stroke(pageB, kitB, 0.6, 0.6)
    // Away from the canvas, so the brush's hover outline is not in the comparison.
    await pageB.mouse.move(1, 1)
    await expect(kitB.getByText(/Alice is painting this layer/)).toBeVisible()
    await pageB.waitForTimeout(1_000)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))).toBe(before)

    // Alice lets go; her stroke lands, and a moment later the layer is free again.
    await pageA.mouse.up()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd')), { timeout: 10_000 }).not.toBe(before)
    await expect(leaseOnBobsSide).toHaveCount(0, { timeout: 20_000 })
    const freed = JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd'))
    await stroke(pageB, kitB, 0.6, 0.6)
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Poster.psd')), { timeout: 10_000 }).not.toBe(freed)
    // Now Alice sees Bob holding it.
    await expect(a.kit.locator('[data-testid^="photo-layer-lease-"]')).toHaveAttribute('data-holder', 'Bob', { timeout: 10_000 })
    await expect.poll(() => sameReplicas(pageA, 'Poster.psd', pageB, 'Shared/Poster.psd'), { timeout: 30_000 }).toBe('same')
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Photo document opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Photo kit editor is not built into public/kits/photo-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Poster.psd', await posterFixture())
  try {
    await expect(kit.getByTestId('photo-status')).toContainText('2 layers', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Poster', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await stroke(page, kit, 0.4, 0.5)
    await expect(kit.getByTestId('photo-unsaved')).toBeVisible()
    await kit.getByTestId('photo-save').click()
    await expect(kit.getByTestId('photo-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Poster.psd'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
