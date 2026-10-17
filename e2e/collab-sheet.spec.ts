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
  signedIn,
  startKitionPro,
  syncNetwork,
  useSyncServer,
} from './helpers/kitionPro'

type NodeSheetDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ SheetDocument: { create(name: string, width: number, height: number): NodeSheetDocument } }>('sheet', 'kition_sheet_sdk')

/** A workbook made by the same engine the page runs: a small budget with a total in B4. */
async function budgetFixture() {
  const sdk = await engine.load()
  const doc = sdk.SheetDocument.create('Budget.xlsx', 0, 0)
  for (const [cell, input] of [['A1', 'Item'], ['B1', 'Cost'], ['A2', 'Rent'], ['B2', '1200'], ['A3', 'Food'], ['B3', '450'], ['A4', 'Total'], ['B4', '=SUM(B2:B3)']]) {
    doc.execute('cell.set', JSON.stringify({ cell, input }))
  }
  doc.execute('selection.set', JSON.stringify({ range: 'A1' }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')

/** Goes to `cell` with the Name Box: the formula bar then shows what the cell holds. */
async function goTo(kit: FrameLocator, cell: string) {
  await kit.getByTestId('sheet-name-box').fill(cell)
  await kit.getByTestId('sheet-name-box').press('Enter')
  await expect(kit.getByTestId('sheet-status')).toHaveText(new RegExp(` · ${cell}$`))
}

/** Enters `input` into `cell` from the formula bar, as typing it and pressing Enter does. */
async function enter(kit: FrameLocator, cell: string, input: string) {
  await goTo(kit, cell)
  await kit.getByTestId('sheet-formula').fill(input)
  await kit.getByTestId('sheet-formula').press('Enter')
}

/** What `cell` holds, as the formula bar shows it (going there first). */
async function expectCell(kit: FrameLocator, cell: string, input: string) {
  await goTo(kit, cell)
  await expect(kit.getByTestId('sheet-formula')).toHaveValue(input, { timeout: 10_000 })
}

/** Inserts a sheet row above `row` (Home › Insert › Insert Sheet Rows on a cell of it). */
async function insertRowAbove(kit: FrameLocator, row: number) {
  await goTo(kit, `A${row}`)
  await kit.getByTestId('ribbon-tab-home').click()
  await kit.getByRole('group', { name: 'Cells' }).getByRole('button', { name: 'Insert', exact: true }).click()
  await kit.getByTestId('sheet-cmd-home.insertRows').click()
}

/** The replica version at `path` once it stops changing. */
async function settledVersion(page: Page, path: string) {
  let previous = null as string | null
  await expect
    .poll(async () => {
      const next = JSON.stringify(await replicaCounters(page, path))
      const stable = next === previous
      previous = next
      return stable
    }, { timeout: 10_000, intervals: [30] })
    .toBe(true)
  return previous ?? ''
}

/**
 * Waits until the replica at `pathA` in `pageA` leaves `baseline` and settles, then until the one at
 * `pathB` in `pageB` reaches the same version; answers the time from `start` to then.
 */
async function liveTo(pageA: Page, pathA: string, pageB: Page, pathB: string, baseline: string, start: number) {
  await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, pathA)), { intervals: [10] }).not.toBe(baseline)
  const version = await settledVersion(pageA, pathA)
  await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, pathB)), { timeout: 5_000, intervals: [20] }).toBe(version)
  return Date.now() - start
}

test('co-edits a workbook between two windows: live, formulas that follow their rows, and merging edits made offline', async ({ browser, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Sheet kit editor is not built into public/kits/sheet-ui')
  test.skip(!kitPackageHasReplicaInfo('sheet', 'kition_sheet_sdk'), 'the Sheet kit package predates replica/info (Kit UI 1.3); build it locally with scripts/build-kit-ui.sh sheet')
  const unavailable = kitionProSkipReason()
  test.skip(Boolean(unavailable), unavailable ?? '')
  test.setTimeout(300_000)
  const server = await startKitionPro(testInfo.outputPath('kition-pro'))
  const alice = await browser.newContext()
  const bob = await browser.newContext()
  const bobNetwork = await syncNetwork(bob)
  const pathA = 'Budget.xlsx'
  const pathB = 'Shared/Budget.xlsx'
  try {
    // Alice opens her workbook and shares it.
    const pageA = await alice.newPage()
    await useSyncServer(pageA, server.url)
    const a = await openInKitFrame(pageA, baseURL!, pathA, await budgetFixture(), {}, signedIn(DEV_PRINCIPALS.alice))
    await expect(a.kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
    const link = await shareFromTab(pageA, 'Budget')
    await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

    // Bob opens the link: the workbook is made in his Shared folder and opens as the same replica.
    const pageB = await bob.newPage()
    await useSyncServer(pageB, server.url)
    const b = await openKitWorkspace(pageB, baseURL!, {}, signedIn(DEV_PRINCIPALS.bob))
    await openSharedLink(pageB, link)
    const kitB = pageB.frameLocator('[data-testid="kit-frame-window"]')
    await expect(kitB.getByTestId('sheet-status')).toHaveText(/^Sheet1 · /, { timeout: 60_000 })
    expect(existsSync(path.join(b.host.root, 'Shared', 'Budget.xlsx'))).toBe(true)
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
    await expect(pageA.locator('.document-tab-list [data-testid="collab-peer"]')).toHaveAttribute('data-peer', 'Bob', { timeout: 15_000 })
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, pathB)), { timeout: 15_000 }).toBe(JSON.stringify(await replicaCounters(pageA, pathA)))

    // Alice changes the rent: within a second Bob's replica has it, and his workbook shows it.
    const editBaseline = JSON.stringify(await replicaCounters(pageB, pathB))
    await goTo(a.kit, 'B2')
    const edited = Date.now()
    await a.kit.getByTestId('sheet-formula').fill('1300')
    await a.kit.getByTestId('sheet-formula').press('Enter')
    const editLive = await liveTo(pageA, pathA, pageB, pathB, editBaseline, edited)
    testInfo.annotations.push({ type: 'live cell edit to the other window', description: `${editLive} ms` })
    expect(editLive).toBeLessThan(1_000)
    await expectCell(kitB, 'B2', '1300')

    // Alice inserts a row above the rent: within a second Bob has it, and the total there still
    // sums the same two rows, now one row down.
    const insertBaseline = JSON.stringify(await replicaCounters(pageB, pathB))
    const inserting = Date.now()
    await insertRowAbove(a.kit, 2)
    const insertLive = await liveTo(pageA, pathA, pageB, pathB, insertBaseline, inserting)
    testInfo.annotations.push({ type: 'live row insert to the other window', description: `${insertLive} ms` })
    expect(insertLive).toBeLessThan(1_000)
    await expectCell(kitB, 'B3', '1300')
    await expectCell(kitB, 'B5', '=SUM(B3:B4)')

    // Bob goes offline and points a formula at Food (row 4 for him); meanwhile Alice inserts
    // another row above the rent, which moves Food to row 5.
    await bobNetwork.setOnline(false)
    await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
    const offlineVersion = JSON.stringify(await replicaCounters(pageA, pathA))
    await enter(kitB, 'D1', '=B4')
    await expectCell(kitB, 'D1', '=B4')
    await insertRowAbove(a.kit, 2)
    await expectCell(a.kit, 'B6', '=SUM(B4:B5)')
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageA, pathA))).not.toBe(offlineVersion)
    expect(JSON.stringify(await replicaCounters(pageB, pathB))).not.toBe(JSON.stringify(await replicaCounters(pageA, pathA)))

    // Back online, both merge on their own: the same replica, both rows inserted, and Bob's
    // formula still points at Food on both sides.
    await bobNetwork.setOnline(true)
    const back = Date.now()
    await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
    await expect.poll(async () => JSON.stringify(await replicaCounters(pageB, pathB)), { timeout: 60_000 }).toBe(JSON.stringify(await replicaCounters(pageA, pathA)))
    testInfo.annotations.push({ type: 'reconnect to converged', description: `${Date.now() - back} ms` })
    for (const kit of [a.kit, kitB]) {
      await expectCell(kit, 'D1', '=B5')
      await expectCell(kit, 'A5', 'Food')
      await expectCell(kit, 'B6', '=SUM(B4:B5)')
    }
    await pageA.screenshot({ path: testInfo.outputPath('alice.png') })
    await pageB.screenshot({ path: testInfo.outputPath('bob.png') })
  } finally {
    await alice.close()
    await bob.close()
    await server.stop()
  }
})

test('without a Kition Pro session a workbook opens, edits, and saves as before, with no sync connection', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Sheet kit editor is not built into public/kits/sheet-ui')
  test.setTimeout(120_000)
  // A sync server is configured, but nobody is signed in: co-editing stays off.
  await useSyncServer(page, 'ws://127.0.0.1:9/v1/sync')
  const sockets = recordWebSockets(page)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Budget.xlsx', await budgetFixture())
  try {
    await expect(kit.getByTestId('sheet-status')).toHaveText('Sheet1 · A1', { timeout: 60_000 })
    // The tab menu offers no sharing.
    await openTabMenu(page, 'Budget', 'Copy path/reference')
    await expect(page.getByRole('menuitem', { name: 'Share for co-editing' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await enter(kit, 'B2', '1300')
    await expect(kit.getByTestId('sheet-unsaved')).toBeVisible()
    await kit.getByTestId('sheet-save').click()
    await expect(kit.getByTestId('sheet-unsaved')).toHaveCount(0, { timeout: 30_000 })
    expect(saves.map((save) => save.path)).toEqual(['Budget.xlsx'])
    await expect(page.locator('[data-testid="collab-status"]')).toHaveCount(0)
    expect(sockets.filter((url) => url.includes('/v1/sync'))).toEqual([])
  } finally {
    await host.dispose()
  }
})
