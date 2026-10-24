import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

type NodeCadDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ CadDocument: { create(name: string, width: number, height: number): NodeCadDocument } }>('cad', 'kition_cad_sdk')

/**
 * A drawing made by the same engine the page runs: a room outline and a column (a circle).
 * Answers the file and the column's handle, which a collaborator moves.
 */
async function planFixture() {
  const sdk = await engine.load()
  const doc = sdk.CadDocument.create('Floor Plan.dxf', 420, 297)
  doc.execute('pline', JSON.stringify({ vertices: [[40, 40], [300, 40], [300, 220], [40, 220]], closed: true }))
  const column = (JSON.parse(doc.execute('circle', JSON.stringify({ center: [120, 120], radius: 12 }))) as { handle: string }).handle
  const bytes = Buffer.from(doc.save())
  doc.free()
  return { bytes, column }
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const objects = (kit: FrameLocator) => kit.getByTestId('cad-status')
const canvas = (kit: FrameLocator) => kit.getByTestId('cad-canvas-region').screenshot()

/** Types `entries` on the kit's command line, one Enter each (an empty entry is a bare Enter). */
async function commandLine(kit: FrameLocator, ...entries: string[]) {
  const line = kit.getByTestId('cad-command-line')
  for (const text of entries) {
    await line.fill(text)
    await line.press('Enter')
  }
}

/** The replica version at `path` once it stops changing (a command can write after its last key). */
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

test('co-edits a CAD drawing between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the CAD kit editor is not built into public/kits/cad-ui')
  test.skip(!kitPackageHasReplicaInfo('cad', 'kition_cad_sdk'), 'the CAD kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh cad')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    const { bytes, column } = await planFixture()

    // Alice opens her drawing and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Floor Plan.dxf', bytes, {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(objects(a.kit)).toHaveText('2 objects', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Floor Plan')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the drawing is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(objects(kitB)).toHaveText('2 objects', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Floor Plan.dxf'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Floor Plan.dxf', pageB, 'Shared/Floor Plan.dxf'), { timeout: 15_000 }).toBe('same')

    // Alice draws a line on the command line: within a second Bob's drawing has it.
    const lineBaseline = JSON.stringify(await replicaCounters(pageB, 'Shared/Floor Plan.dxf'))
    await commandLine(a.kit, 'line', '60,60', '200,120', '')
    const drawn = Date.now()
    await expect(objects(a.kit)).toHaveText('3 objects')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf')), { intervals: [10] }).not.toBe(lineBaseline)
    const aliceLineVersion = await settledVersion(pageA, 'Floor Plan.dxf')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Floor Plan.dxf')), { timeout: 5_000, intervals: [20] }).toBe(aliceLineVersion)
    const lineLive = Date.now() - drawn
    testInfo.annotations.push({ type: 'live line to the other window', description: `${lineLive} ms` })
    expect(lineLive).toBeLessThan(1_000)
    await expect(objects(kitB)).toHaveText('3 objects', { timeout: 5_000 })

    // Bob moves the column (another entity): within a second Alice's canvas shows it moved.
    const aliceBeforeMove = await canvas(a.kit)
    const moveBaseline = JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf'))
    await commandLine(kitB, `move ${JSON.stringify({ handles: [column], delta: [80, 40] })}`)
    const moved = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Floor Plan.dxf')), { intervals: [10] }).not.toBe(moveBaseline)
    const bobMoveVersion = await settledVersion(pageB, 'Shared/Floor Plan.dxf')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf')), { timeout: 5_000, intervals: [20] }).toBe(bobMoveVersion)
    const moveLive = Date.now() - moved
    testInfo.annotations.push({ type: 'live move to the other window', description: `${moveLive} ms` })
    expect(moveLive).toBeLessThan(1_000)
    await expect.poll(async () => (await canvas(a.kit)).equals(aliceBeforeMove), { timeout: 5_000 }).toBe(false)
    await expect(objects(a.kit)).toHaveText('3 objects')

    // Bob goes offline and draws a circle; Alice draws a line meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf'))
    await commandLine(kitB, `circle ${JSON.stringify({ center: [250, 180], radius: 15 })}`)
    await expect(objects(kitB)).toHaveText('4 objects')
    await commandLine(a.kit, 'line', '50,200', '280,60', '')
    await expect(objects(a.kit)).toHaveText('4 objects')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf'))).not.toBe(offlineVersion)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Floor Plan.dxf'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Floor Plan.dxf')))

    // Back online, both merge on their own: the same replica, with the circle and the line.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Floor Plan.dxf', pageB, 'Shared/Floor Plan.dxf'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(objects(a.kit)).toHaveText('5 objects')
    await expect(objects(kitB)).toHaveText('5 objects')
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a CAD drawing opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the CAD kit editor is not built into public/kits/cad-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Floor Plan.dxf', (await planFixture()).bytes)
  try {
    await expect(objects(kit)).toHaveText('2 objects', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Floor Plan', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await commandLine(kit, 'line', '60,60', '200,120', '')
    await expect(objects(kit)).toHaveText('3 objects')
    await expect(kit.getByTestId('cad-unsaved')).toBeVisible()
    await kit.getByTestId('cad-save').click()
    await expect(kit.getByTestId('cad-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Floor Plan.dxf'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
