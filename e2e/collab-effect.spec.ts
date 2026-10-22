import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

type NodeEffectDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ EffectDocument: { create(name: string, width: number, height: number): NodeEffectDocument } }>('effect', 'kition_effect_sdk')

/**
 * A two-second composition made by the engine the page runs: a red solid whose opacity fades in
 * (keys at 0 s and 1 s) under a blue solid (the newest layer is on top), nothing selected.
 */
async function motionFixture() {
  const sdk = await engine.load()
  const doc = sdk.EffectDocument.create('Motion.keffect', 320, 180)
  doc.execute('comp.settings', JSON.stringify({ duration: 2 }))
  const red = (JSON.parse(doc.execute('layer.newSolid', JSON.stringify({ name: 'Red', color: '#ff0000' }))) as { layer: number }).layer
  doc.execute('prop.addKey', JSON.stringify({ layer: red, path: 'transform/opacity', time: 0, value: 0 }))
  doc.execute('prop.addKey', JSON.stringify({ layer: red, path: 'transform/opacity', time: 1, value: 100 }))
  doc.execute('layer.newSolid', JSON.stringify({ name: 'Blue', color: '#0000ff' }))
  doc.execute('layer.select', JSON.stringify({ layers: [] }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const row = (kit: FrameLocator, name: string) => kit.locator('.effect-row', { hasText: name })
const order = (kit: FrameLocator) => kit.locator('.effect-row .effect-row-name')
const opacity = (kit: FrameLocator) => kit.getByTestId('effect-value-opacity-0')

/** Selects the layer named `name` and sets its opacity (a keyframe edit: the property is animated) at the current time. */
async function setOpacity(kit: FrameLocator, name: string, value: number) {
  await row(kit, name).click()
  await expect(kit.getByTestId('effect-properties-panel')).toContainText(name)
  await opacity(kit).fill(String(value))
  await opacity(kit).press('Enter')
}

/** Selects the layer named `name` and brings it forward one place (Layer ▸ Arrange ▸ Bring Layer Forward, Cmd/Ctrl+]). */
async function bringForward(page: Page, kit: FrameLocator, name: string) {
  await row(kit, name).click()
  await page.keyboard.press('Control+BracketRight')
}

test('co-edits a motion project between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Effect kit editor is not built into public/kits/effect-ui')
  test.skip(!kitPackageHasReplicaInfo('effect', 'kition_effect_sdk'), 'the Effect kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh effect')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her project and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Motion.keffect', await motionFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('effect-status')).toContainText('2 layers', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Motion')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the project is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('effect-status')).toContainText('2 layers', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Motion.keffect'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Motion.keffect', pageB, 'Shared/Motion.keffect'), { timeout: 15_000 }).toBe('same')
    await expect(order(kitB)).toHaveText(['Blue', 'Red'])

    // Bob looks at Red's transform (his own selection, not Alice's).
    await row(kitB, 'Red').click()
    await expect(opacity(kitB)).toHaveValue('0')

    // Alice edits Red's opacity key at 0 s: within a second Bob's panel shows it.
    const beforeKey = JSON.stringify(await replicaCounters(pageA, 'Motion.keffect'))
    await setOpacity(a.kit, 'Red', 40)
    const keyed = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Motion.keffect')), { intervals: [10] }).not.toBe(beforeKey)
    const aliceKeyVersion = JSON.stringify(await replicaCounters(pageA, 'Motion.keffect'))
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Motion.keffect')), { timeout: 5_000, intervals: [20] }).toBe(aliceKeyVersion)
    const keyLive = Date.now() - keyed
    testInfo.annotations.push({ type: 'live keyframe edit to the other window', description: `${keyLive} ms` })
    expect(keyLive).toBeLessThan(1_000)
    await expect(opacity(kitB)).toHaveValue('40', { timeout: 5_000 })

    // Alice moves Red above Blue: within a second Bob's timeline has Red on top.
    const beforeMove = JSON.stringify(await replicaCounters(pageA, 'Motion.keffect'))
    await bringForward(pageA, a.kit, 'Red')
    const moved = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Motion.keffect')), { intervals: [10] }).not.toBe(beforeMove)
    const aliceMoveVersion = JSON.stringify(await replicaCounters(pageA, 'Motion.keffect'))
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Motion.keffect')), { timeout: 5_000, intervals: [20] }).toBe(aliceMoveVersion)
    const moveLive = Date.now() - moved
    testInfo.annotations.push({ type: 'live layer move to the other window', description: `${moveLive} ms` })
    expect(moveLive).toBeLessThan(1_000)
    await expect(order(a.kit)).toHaveText(['Red', 'Blue'])
    await expect(order(kitB)).toHaveText(['Red', 'Blue'], { timeout: 5_000 })

    // Bob goes offline and keys Blue's opacity at 1.5 s; Alice edits Red's opacity again meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await row(kitB, 'Blue').click()
    const ruler = (await kitB.getByTestId('effect-ruler').boundingBox())!
    await pageB.mouse.click(ruler.x + ruler.width * 0.75, ruler.y + ruler.height / 2)
    await expect(kitB.getByTestId('effect-timecode')).not.toHaveText('0:00:00:00')
    await kitB.getByTestId('effect-add-key-opacity').click()
    await expect(row(kitB, 'Blue').getByTestId('effect-key')).toHaveCount(1)
    await setOpacity(a.kit, 'Red', 60)
    await expect(opacity(a.kit)).toHaveValue('60')
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Motion.keffect'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Motion.keffect')))

    // Back online, both merge on their own: the same replica, and both edits in both windows.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Motion.keffect', pageB, 'Shared/Motion.keffect'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(row(a.kit, 'Blue').getByTestId('effect-key')).toHaveCount(1, { timeout: 5_000 })
    await expect(row(kitB, 'Red').getByTestId('effect-key')).toHaveCount(2)
    await row(kitB, 'Red').click()
    await pageB.mouse.click(ruler.x + 1, ruler.y + ruler.height / 2)
    await expect(kitB.getByTestId('effect-timecode')).toHaveText('0:00:00:00')
    await expect(opacity(kitB)).toHaveValue('60', { timeout: 5_000 })
    await expect(order(a.kit)).toHaveText(['Red', 'Blue'])
    await expect(order(kitB)).toHaveText(['Red', 'Blue'])
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a motion project opens and edits as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Effect kit editor is not built into public/kits/effect-ui')
  test.setTimeout(120_000)
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Motion.keffect', await motionFixture())
  try {
    await expect(kit.getByTestId('effect-status')).toContainText('2 layers', { timeout: 60_000 })
    await openTabMenu(page, 'Motion', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await bringForward(page, kit, 'Red')
    await expect(order(kit)).toHaveText(['Red', 'Blue'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
