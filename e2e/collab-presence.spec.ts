import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, sameReplicas, shareFromTab, signedIn, startKitionPro, useSyncServer } from './helpers/kitionPro'

/**
 * Presence (Kit UI protocol section 7e): what one person selects in a co-edited slide file travels as
 * KDM object ids through their presence in the room, and the other person's kit outlines it in
 * their color with their name.
 */
type NodeSlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{
  SlideDocument: { create(name: string, width: number, height: number): NodeSlideDocument }
}>('slide', 'kition_slide_sdk')

/** A one-slide slide file whose lone shape is a text box across the slide's middle, where a click selects it. */
async function slideFixture() {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.create('Keynote.kitionslide', 960, 540)
  doc.execute('edit.selectAll', '{}')
  doc.execute('edit.delete', '{}')
  doc.execute('insert.textBox', JSON.stringify({ rect: [0, 255, 960, 30], text: 'Hello' }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** Whether the Slide kit package shares presence (Kit UI protocol 1.7): its editor speaks `presence/set`. */
function kitPackageSharesPresence() {
  const assets = path.join(process.cwd(), 'public', 'kits', 'slide-ui', 'assets')
  if (!existsSync(assets)) return false
  return readdirSync(assets).some((name) => name.endsWith('.js') && readFileSync(path.join(assets, name), 'utf8').includes('presence.locate'))
}

const canvas = (kit: FrameLocator) =>
  kit.getByTestId('slides-canvas-region').screenshot({ animations: 'disabled', mask: [kit.owner().page().getByTestId('agent-floating-launcher')] })

test('Bob sees the shape Alice selected on a shared slide, outlined with her name', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Slide kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slide kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
  test.skip(!kitPackageSharesPresence(), 'the Slide kit package predates presence (Kit UI 1.7); build it locally with scripts/build-kit-ui.sh slide')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Keynote.kitionslide', await slideFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('slides-status')).toHaveText('Slide 1 of 1', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Keynote')
    await expect(pageA.locator('.document-tab-list [data-testid="collab-status"]')).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 1', { timeout: 60_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Keynote.kitionslide', pageB, 'Shared/Keynote.kitionslide'), { timeout: 15_000 }).toBe('same')
    await expect(kitB.getByTestId('slides-peer-selection')).toHaveCount(0)
    const before = await canvas(kitB)

    // Alice clicks the text box: Bob's kit names her selection and outlines it on his canvas.
    const region = (await a.kit.getByTestId('slides-canvas-region').boundingBox())!
    await pageA.mouse.click(region.x + region.width / 2, region.y + region.height / 2)
    const selected = Date.now()
    const mark = kitB.getByTestId('slides-peer-selection')
    await expect(mark).toHaveAttribute('data-peer', 'Alice', { timeout: 10_000 })
    testInfo.annotations.push({ type: 'selection to the other window', description: `${Date.now() - selected} ms` })
    await expect(mark).toHaveText('Alice has 1 selected')
    await expect.poll(async () => (await canvas(kitB)).equals(before), { timeout: 5_000 }).toBe(false)
    await pageB.screenshot({ path: testInfo.outputPath('bob-sees-alice-selection.png') })

    // Alice clicks off the shape: her selection leaves Bob's screen.
    await pageA.keyboard.press('Escape')
    await pageA.keyboard.press('Escape')
    await expect(mark).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})
