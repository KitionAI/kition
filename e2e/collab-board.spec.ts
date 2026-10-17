import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openKitWorkspace } from './helpers/embeddedKit'
import { dismissFirstRunActivation } from './helpers/onboarding'
import {
  DEV_PRINCIPALS,
  kitionProSkipReason,
  openSharedLink,
  openTabMenu,
  recordWebSockets,
  shareFromTab,
  shareViewOnlyFromTab,
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

// Co-editing a Board (`.kiboard`) between two windows through the Kition Pro sync server: a shape
// drawn in one shows in the other within a second, shapes drawn while one window was offline
// merge when it is back, a viewer cannot change the board, and without Kition Pro nothing changes.

type BoardSnapshot = { docId: string; kdmVersion: string; records: Array<{ record_type: string; id: string }> }

/** A new empty board's file text, made by the app's own encoder in the page. */
async function emptyBoardText(page: Page, title: string) {
  return page.evaluate(async (name) => {
    const load = (module: string) => import(/* @vite-ignore */ new URL(module, window.location.href).href)
    const [{ createEmptyBoard, encodeBoardFile }, { randomActor }] = await Promise.all([load('/src/features/whiteboard/kdm/boardKdmFile.ts'), load('/src/lib/kdm/index.ts')])
    return encodeBoardFile(createEmptyBoard(name, randomActor())) as string
  }, title)
}

/** Alice's workspace with the board `Plan.kiboard` open. */
async function openAliceBoard(page: Page, baseURL: string) {
  const workspace = await openKitWorkspace(page, baseURL, {}, signedIn(DEV_PRINCIPALS.alice))
  await fs.writeFile(path.join(workspace.host.root, 'Plan.kiboard'), await emptyBoardText(page, 'Plan'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissFirstRunActivation(page)
  await page.locator('.document-tree-row', { hasText: 'Plan' }).first().click()
  await waitForBoard(page)
  return workspace
}

async function waitForBoard(page: Page) {
  await expect(page.getByTestId('whiteboard-svg-scene')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => Boolean(window.__KITION_WHITEBOARD_TEST__))).toBe(true)
}

async function snapshot(page: Page) {
  return page.evaluate(() => window.__KITION_WHITEBOARD_TEST__!.read()) as Promise<BoardSnapshot>
}

async function elementIds(page: Page) {
  return (await snapshot(page)).records.filter((record) => record.record_type === 'element').map((record) => record.id).sort()
}

/** Draws a rectangle with the toolbar's rectangle tool; answers its element id. */
async function drawRectangle(page: Page, at: { x: number; y: number }) {
  const before = new Set(await elementIds(page))
  await page.getByTestId('whiteboard-tool-rectangle').click()
  const bounds = (await page.getByTestId('whiteboard-svg-scene').boundingBox())!
  await page.mouse.move(bounds.x + at.x, bounds.y + at.y)
  await page.mouse.down()
  await page.mouse.move(bounds.x + at.x + 120, bounds.y + at.y + 80, { steps: 8 })
  await page.mouse.up()
  let id = ''
  await expect.poll(async () => {
    id = (await elementIds(page)).find((candidate) => !before.has(candidate)) ?? ''
    return id
  }).not.toBe('')
  return id
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

test('co-edits a board between two windows: live, and merging shapes drawn offline', async ({ browser, baseURL }, testInfo) => {
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
    await openAliceBoard(pageA, baseURL!)
    const link = await shareFromTab(pageA, 'Plan')
    expect(link).toMatch(/\/s\/\S+$/)
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: Shared/Plan.kiboard, the same document.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    await waitForBoard(pageB)
    expect(existsSync(path.join(b.host.root, 'Shared', 'Plan.kiboard'))).toBe(true)
    expect((await snapshot(pageB)).docId).toBe((await snapshot(pageA)).docId)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })

    // Alice draws: within a second the shape is on Bob's board.
    const drawn = await drawRectangle(pageA, { x: 200, y: 200 })
    const at = Date.now()
    await expect.poll(() => elementIds(pageB), { timeout: 5_000, intervals: [20] }).toContain(drawn)
    const live = Date.now() - at
    testInfo.annotations.push({ type: 'live edit to the other window', description: `${live} ms` })
    expect(live).toBeLessThan(1_000)
    await expect(pageB.locator(`[data-element-id="${drawn}"]`)).toBeVisible()
    // Bob's undo cannot take back Alice's shape: the merge is no undo step of his.
    await pageB.getByTestId('whiteboard-svg-scene').click({ position: { x: 700, y: 150 } })
    await pageB.keyboard.press('ControlOrMeta+z')
    expect(await elementIds(pageB)).toContain(drawn)

    // Bob goes offline and draws; Alice draws meanwhile.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const fromBob = await drawRectangle(pageB, { x: 420, y: 320 })
    const fromAlice = await drawRectangle(pageA, { x: 120, y: 420 })
    expect(await elementIds(pageA)).not.toContain(fromBob)
    expect(await elementIds(pageB)).not.toContain(fromAlice)

    // Back online: both boards have both shapes, at the same version.
    await bobNetwork.setOnline(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    for (const page of [pageA, pageB]) await expect.poll(() => elementIds(page), { timeout: 60_000 }).toEqual(expect.arrayContaining([drawn, fromAlice, fromBob]))
    await expect.poll(async () => (await snapshot(pageB)).kdmVersion, { timeout: 30_000 }).toBe((await snapshot(pageA)).kdmVersion)
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('a viewer of a shared board sees it change but cannot change it', async ({ browser, baseURL }, testInfo) => {
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(240_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  try {
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    await openAliceBoard(pageA, baseURL!)
    const first = await drawRectangle(pageA, { x: 200, y: 200 })
    const { viewLink } = await shareViewOnlyFromTab(pageA, 'Plan')

    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, viewLink)
    await waitForBoard(pageB)
    await expect(pageB.getByTestId('whiteboard-editor-pane')).toHaveAttribute('data-read-only', 'true', { timeout: 15_000 })
    await expect(pageB.locator('.document-tab-list [data-testid="collab-view-only"]')).toBeVisible({ timeout: 15_000 })
    await expect(pageB.getByTestId('whiteboard-tool-rectangle')).toHaveCount(0)
    expect(await elementIds(pageB)).toContain(first)

    // Selecting Alice's shape and deleting it, or dragging it, changes nothing.
    const version = (await snapshot(pageB)).kdmVersion
    const shape = pageB.locator(`[data-element-id="${first}"]`)
    await shape.click()
    await pageB.keyboard.press('Delete')
    const box = (await shape.boundingBox())!
    await pageB.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await pageB.mouse.down()
    await pageB.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 })
    // The drag never starts: mid-gesture the shape is where it was (it does not snap back at the end).
    expect(await shape.boundingBox()).toEqual(box)
    await pageB.mouse.up()
    expect(await elementIds(pageB)).toContain(first)
    expect((await snapshot(pageB)).kdmVersion).toBe(version)

    // Alice's next shape still reaches the viewer.
    const second = await drawRectangle(pageA, { x: 420, y: 320 })
    await expect.poll(() => elementIds(pageB), { timeout: 10_000 }).toContain(second)
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a board opens and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.setTimeout(120_000)
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host } = await openKitWorkspace(page, baseURL!)
  try {
    await fs.writeFile(path.join(host.root, 'Plan.kiboard'), await emptyBoardText(page, 'Plan'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Plan' }).first().click()
    await waitForBoard(page)
    await openTabMenu(page, 'Plan', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const drawn = await drawRectangle(page, { x: 200, y: 200 })
    await expect.poll(async () => (await fs.readFile(path.join(host.root, 'Plan.kiboard'), 'utf8')).length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(async () => {
      const text = await fs.readFile(path.join(host.root, 'Plan.kiboard'), 'utf8')
      return page.evaluate(async ({ text: file, id }) => {
        const load = (module: string) => import(/* @vite-ignore */ new URL(module, window.location.href).href)
        const [{ decodeBoardFile }, { randomActor }] = await Promise.all([load('/src/features/whiteboard/kdm/boardKdmFile.ts'), load('/src/lib/kdm/index.ts')])
        const decoded = decodeBoardFile(file, randomActor())
        return decoded.kind === 'board' && decoded.replica.exists(id)
      }, { text, id: drawn })
    }, { timeout: 10_000 }).toBe(true)
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    await expect(page.getByTestId('whiteboard-editor-pane')).not.toHaveAttribute('data-read-only', 'true')
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
