import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

type NodeCubeDocument = { save(): Uint8Array; free(): void }
const engine = kitEngine<{ CubeDocument: { create(name: string, width: number, height: number): NodeCubeDocument } }>('cube', 'kition_cube_sdk')

/** The starter scene the page's engine makes: a cube, a light, and a camera. */
async function roomFixture() {
  const sdk = await engine.load()
  const doc = sdk.CubeDocument.create('Room.kcube', 1280, 720)
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const objects = (kit: FrameLocator) => kit.getByTestId('cube-status')
const outliner = (kit: FrameLocator, name: string) => kit.locator(`[data-testid="cube-outliner-item"][data-name="${name}"]`)

/** Add ▸ Mesh ▸ `command` from the kit's menus. */
async function addMesh(kit: FrameLocator, command: string) {
  await kit.getByTestId('cube-menu-Add').click()
  await kit.locator('[role="menuitem"][data-kit-ui-id="menu:Add/Mesh"]').hover()
  await kit.getByTestId(`cube-cmd-${command}`).click()
}

/** The replica version at `path` once it stops changing. */
async function settledVersion(page: Page, path: string) {
  let previous = ''
  await expect
    .poll(async () => {
      const next = JSON.stringify(await replicaCounters(page, path))
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous
}

test('co-edits a 3D scene between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Cube kit editor is not built into public/kits/cube-ui')
  test.skip(!kitPackageHasReplicaInfo('cube', 'kition_cube_sdk'), 'the Cube kit package predates engine contract 2; build it with scripts/build-kit-ui.sh cube')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her scene and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Room.kcube', await roomFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(objects(a.kit)).toContainText('3 objects', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Room')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the scene is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(objects(kitB)).toContainText('3 objects', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Room.kcube'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Room.kcube', pageB, 'Shared/Room.kcube'), { timeout: 15_000 }).toBe('same')

    // Alice adds a sphere: within a second Bob's scene has it.
    const sphereBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Room.kcube'))
    await addMesh(a.kit, 'add.uvSphere')
    const added = Date.now()
    await expect(objects(a.kit)).toContainText('4 objects')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Room.kcube')), { intervals: [10] }).not.toBe(sphereBaseline)
    const aliceVersion = await settledVersion(pageA, 'Room.kcube')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Room.kcube')), { timeout: 5_000, intervals: [20] }).toBe(aliceVersion)
    const addLive = Date.now() - added
    testInfo.annotations.push({ type: 'live add to the other window', description: `${addLive} ms` })
    expect(addLive).toBeLessThan(1_000)
    await expect(outliner(kitB, 'Sphere')).toBeVisible({ timeout: 5_000 })

    // Bob moves the cube in its properties: Alice's scene follows.
    await outliner(kitB, 'Cube').click()
    const field = kitB.getByTestId('cube-location-x').locator('input')
    await field.fill('3')
    await field.press('Enter')
    const bobVersion = await settledVersion(pageB, 'Shared/Room.kcube')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Room.kcube')), { timeout: 5_000, intervals: [20] }).toBe(bobVersion)
    await outliner(a.kit, 'Cube').click()
    await expect(a.kit.getByTestId('cube-location-x').locator('input')).toHaveValue(/^3(\.0+)?$/, { timeout: 5_000 })

    // Bob goes offline and adds a cylinder; Alice adds a cone meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await addMesh(kitB, 'add.cylinder')
    await expect(objects(kitB)).toContainText('5 objects')
    await addMesh(a.kit, 'add.cone')
    await expect(objects(a.kit)).toContainText('5 objects')

    // Back online, both merge on their own: the same replica, with the cylinder and the cone.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Room.kcube', pageB, 'Shared/Room.kcube'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(objects(a.kit)).toContainText('6 objects')
    await expect(objects(kitB)).toContainText('6 objects')
    for (const name of ['Cylinder', 'Cone']) {
      await expect(outliner(a.kit, name)).toBeVisible()
      await expect(outliner(kitB, name)).toBeVisible()
    }
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a 3D scene opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Cube kit editor is not built into public/kits/cube-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Room.kcube', await roomFixture())
  try {
    await expect(objects(kit)).toContainText('3 objects', { timeout: 60_000 })
    await openTabMenu(page, 'Room', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await addMesh(kit, 'add.uvSphere')
    await expect(objects(kit)).toContainText('4 objects')
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['Room.kcube'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
