import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { filmAddEdit, filmClips } from './helpers/film'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, openTabMenu, recordWebSockets, replicaCounters, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from './helpers/kitionPro'

const CLIP = path.join(process.cwd(), 'e2e', 'fixtures', 'film', 'bars.mp4')

type NodeFilmDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ FilmDocument: { create(name: string, width: number, height: number): NodeFilmDocument } }>('film', 'kition_film_sdk')

/** A project with the clip `bars.mp4` (next to it) on V1, made by the engine the page runs. */
async function trailerFixture(clip: Buffer) {
  Object.assign(globalThis, {
    kitionHost: {
      size: (file: string) => (file === 'bars.mp4' ? clip.byteLength : 0),
      readRange: (file: string, offset: number, length: number) => new Uint8Array(file === 'bars.mp4' ? clip.subarray(offset, offset + length) : []),
    },
  })
  const sdk = await engine.load()
  const doc = sdk.FilmDocument.create('Trailer.kitionfilm', 320, 180)
  const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: ['bars.mp4'] }))) as { items: number[] }
  doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const clips = filmClips
const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/**
 * Cuts the clip on V1 at `at` (a fraction of the whole track's clips): moves the playhead there on
 * the time ruler, then Add Edit.
 */
async function cutAt(page: Page, kit: FrameLocator, at: number) {
  const first = (await clips(kit).first().boundingBox())!
  const last = (await clips(kit).last().boundingBox())!
  const ruler = (await kit.getByTestId('film-ruler').boundingBox())!
  await page.mouse.click(first.x + (last.x + last.width - first.x) * at, ruler.y + ruler.height / 2)
  await filmAddEdit(page, kit)
}

test('co-edits a Film project between two windows: live, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Film kit editor is not built into public/kits/film-ui')
  test.skip(!kitPackageHasReplicaInfo('film', 'kition_film_sdk'), 'the Film kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh film')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const clip = await fs.readFile(CLIP)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  try {
    // Alice opens her project and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Trailer.kitionfilm', await trailerFixture(clip), { 'bars.mp4': clip }, signedIn(DEV_PRINCIPALS.alice))
    await expect(clips(a.kit)).toHaveCount(1, { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Trailer')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link; his copy of the clip sits next to where the project lands.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, { 'Shared/bars.mp4': clip }, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(clips(kitB)).toHaveCount(1, { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Trailer.kitionfilm'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Trailer.kitionfilm', pageB, 'Shared/Trailer.kitionfilm'), { timeout: 15_000 }).toBe('same')

    // Alice cuts the clip: within a second Bob's timeline has both halves.
    const before = JSON.stringify(await replicaCounters(pageA, 'Trailer.kitionfilm'))
    await cutAt(pageA, a.kit, 0.5)
    // From the Add Edit until Bob's replica holds everything Alice's does.
    const cut = Date.now()
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Trailer.kitionfilm')), { intervals: [10] }).not.toBe(before)
    const aliceVersion = JSON.stringify(await replicaCounters(pageA, 'Trailer.kitionfilm'))
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Shared/Trailer.kitionfilm')), { timeout: 5_000, intervals: [20] }).toBe(aliceVersion)
    const live = Date.now() - cut
    testInfo.annotations.push({ type: 'live edit to the other window', description: `${live} ms` })
    expect(live).toBeLessThan(1_000)
    await expect(clips(a.kit)).toHaveCount(2)
    await expect(clips(kitB)).toHaveCount(2)

    // Bob goes offline and cuts the second half; Alice cuts the first half meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    await cutAt(pageB, kitB, 0.8)
    await expect(clips(kitB)).toHaveCount(3)
    await cutAt(pageA, a.kit, 0.2)
    await expect(clips(a.kit)).toHaveCount(3)
    expect(JSON.stringify(await replicaCounters(pageB, 'Shared/Trailer.kitionfilm'))).not.toBe(JSON.stringify(await replicaCounters(pageA, 'Trailer.kitionfilm')))

    // Back online, both merge on their own: the same replica, and both cuts on both timelines.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(() => sameReplicas(pageA, 'Trailer.kitionfilm', pageB, 'Shared/Trailer.kitionfilm'), { timeout: 60_000 }).toBe('same')
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    await expect(clips(a.kit)).toHaveCount(4)
    await expect(clips(kitB)).toHaveCount(4)
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a Film project opens and edits as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Film kit editor is not built into public/kits/film-ui')
  test.setTimeout(120_000)
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const clip = await fs.readFile(CLIP)
  const { host, kit } = await openInKitFrame(page, baseURL!, 'Trailer.kitionfilm', await trailerFixture(clip), { 'bars.mp4': clip })
  try {
    await expect(clips(kit)).toHaveCount(1, { timeout: 60_000 })
    await openTabMenu(page, 'Trailer', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await cutAt(page, kit, 0.5)
    await expect(clips(kit)).toHaveCount(2)
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
