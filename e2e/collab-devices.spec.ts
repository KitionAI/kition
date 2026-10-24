import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openTabMenu, replicaCounters, sameReplicas, signedIn, startKitionPro, useSyncServer } from './helpers/kitionPro'

type NodeSlideDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{
  SlideDocument: { create(name: string, width: number, height: number): NodeSlideDocument }
}>('slide', 'kition_slide_sdk')

/** A slide file made by the same engine the page runs: slide 1 is a full-slide text box, slide 2 a square. */
async function slideFixture() {
  const sdk = await engine.load()
  const doc = sdk.SlideDocument.create('Keynote.kslide', 960, 540)
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

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/** The replica version at `path` once it stops changing (typing commits one transaction per key). */
async function settledVersion(page: Page, file: string) {
  let previous: string | null = null
  await expect
    .poll(async () => {
      const next = JSON.stringify(await replicaCounters(page, file))
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous as string
}

/** Clicks the lone text box on the current slide and types `text` there. */
async function typeIntoShape(page: Page, kit: FrameLocator, text: string) {
  const region = (await kit.getByTestId('slides-canvas-region').boundingBox())!
  await page.mouse.click(region.x + region.width / 2, region.y + region.height / 2)
  await expect(kit.locator('[data-testid="kit-text-sink"]')).toBeFocused({ timeout: 10_000 })
  await page.keyboard.type(text)
}

/** Opens "Your synced documents" from the command palette. */
async function openSyncedDocuments(page: Page) {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-row').filter({ hasText: 'Your synced documents' }).click({ timeout: 15_000 })
  await expect(page.getByTestId('collab-synced-dialog')).toBeVisible()
}

test('syncs a slide file across one person\'s two devices: synced on one, listed and opened on the other, edited on both', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Slide kit editor is not built into public/kits/slide-ui')
  test.skip(!kitPackageHasReplicaInfo('slide', 'kition_slide_sdk'), 'the Slide kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh slide')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  // One person (Alice), two devices: two browser contexts, each with its own workspace.
  const laptop = await browser.newContext()
  const desktop = await browser.newContext()
  try {
    // On the laptop, Alice syncs her slide file to her devices: no share link, nobody else.
    const pageA = await laptop.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, 'Keynote.kslide', await slideFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    await (await openTabMenu(pageA, 'Keynote', 'Sync to my devices')).click()
    await expect(pageA.getByText('Synced to your devices')).toBeVisible({ timeout: 30_000 })
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    // Synced: the tab menu no longer offers it.
    await openTabMenu(pageA, 'Keynote', 'Share for co-editing')
    await expect(pageA.getByRole('menuitem', { name: 'Sync to my devices' })).toHaveCount(0)
    await pageA.keyboard.press('Escape')

    // On the desktop, her synced documents list the slide file, which is not in this workspace yet.
    const pageB = await desktop.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.alice))
    await openSyncedDocuments(pageB)
    const row = pageB.getByTestId('collab-synced-document').filter({ hasText: 'Keynote.kslide' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Only you')
    await expect(pageB.getByTestId('collab-synced-folder')).toHaveValue('')
    await pageB.screenshot({ path: testInfo.outputPath('desktop-synced-documents.png') })

    // Open here: the slide file is made in the workspace as the same document and opens.
    await row.getByTestId('collab-synced-open').click()
    await expect(pageB.getByTestId('collab-synced-dialog')).toHaveCount(0, { timeout: 30_000 })
    const kitB = pageB.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('slides-status')).toHaveText('Slide 1 of 2', { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Keynote.kslide'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect.poll(() => sameReplicas(pageA, 'Keynote.kslide', pageB, 'Keynote.kslide'), { timeout: 15_000 }).toBe('same')

    // Now here, it is no longer listed.
    await openSyncedDocuments(pageB)
    await expect(pageB.getByTestId('collab-synced-empty')).toBeVisible({ timeout: 15_000 })
    await pageB.keyboard.press('Escape')
    await expect(pageB.getByTestId('collab-synced-dialog')).toHaveCount(0)

    // Alice types on the laptop: the desktop has it live.
    const baseline = JSON.stringify(await replicaCounters(pageB, 'Keynote.kslide'))
    await typeIntoShape(pageA, a.kit, 'Launch day')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, 'Keynote.kslide')), { intervals: [10] }).not.toBe(baseline)
    const laptopVersion = await settledVersion(pageA, 'Keynote.kslide')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, 'Keynote.kslide')), { timeout: 10_000, intervals: [20] }).toBe(laptopVersion)

    // She adds a slide on the desktop, and one on the laptop: both converge with both slides.
    await pageA.keyboard.press('Escape')
    await kitB.getByTestId('slides-add-slide').click()
    await expect(kitB.getByTestId('slides-status')).toHaveText(/of 3$/)
    await expect(a.kit.getByTestId('slides-status')).toHaveText(/of 3$/, { timeout: 10_000 })
    await a.kit.getByTestId('slides-add-slide').click()
    await expect(a.kit.getByTestId('slides-status')).toHaveText(/of 4$/)
    await expect(kitB.getByTestId('slides-status')).toHaveText(/of 4$/, { timeout: 10_000 })
    await expect.poll(() => sameReplicas(pageA, 'Keynote.kslide', pageB, 'Keynote.kslide'), { timeout: 30_000 }).toBe('same')
    await pageA.screenshot({ path: testInfo.outputPath('laptop.png') })
    await pageB.screenshot({ path: testInfo.outputPath('desktop.png') })
  } finally {
    await laptop.close()
    await desktop.close()
    await server.stop()
  }
})
