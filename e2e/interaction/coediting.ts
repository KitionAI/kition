/**
 * Host matrix row H13 (co-editing) for the kits without a collab-<kit> spec: Alice shares a file,
 * Bob opens the link, an edit goes each way live, then both edit while Bob is offline and the two
 * windows converge when he is back. It needs a kition-pro checkout beside Kition (or
 * KITION_PRO_REPO) and Rust, and skips plainly without them.
 */
import path from 'node:path'
import { existsSync } from 'node:fs'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame, openKitWorkspace, type KitModes } from '../helpers/embeddedKit'
import { DEV_PRINCIPALS, kitionProSkipReason, kitPackageHasReplicaInfo, openSharedLink, sameReplicas, shareFromTab, signedIn, startKitionPro, syncNetwork, useSyncServer } from '../helpers/kitionPro'
import { tags } from './support'

export type CoEditCase = {
  /** The kit's name (`board`), its engine module, and its file at the workspace root. */
  kit: string
  module: string
  file: string
  /** The file's tab title, which the share menu is opened from. */
  title: string
  fixture: () => Promise<Buffer>
  /** The measure the editor shows for `fixture` (a count every `edit` raises by one). */
  count: number
  shows: (kit: FrameLocator, count: number) => Promise<void>
  /** One edit through the editor's own UI; `slot` (0 to 3) keeps each edit apart from the others. */
  edit: (page: Page, kit: FrameLocator, slot: number) => Promise<void>
  /** Kit editor display modes to pin in both windows. */
  modes?: KitModes
}

const status = (page: Page) => page.locator('.document-tab-list [data-testid="collab-status"]')
const activeKit = (page: Page) => page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')

export function coEditing(c: CoEditCase) {
  test(`H13: a ${c.kit} file co-edited in two windows converges, live and after an offline edit`, tags(c.kit, ['H13'], true), async ({ browser, baseURL }, testInfo) => {
    test.skip(!kitPackageHasReplicaInfo(c.kit, c.module), `the ${c.kit} kit package has no replica info`)
    const unavailable = kitionProSkipReason()
    test.skip(Boolean(unavailable), unavailable ?? '')
    test.setTimeout(360_000)
    const server = await startKitionPro(testInfo.outputPath('kition-pro'))
    const alice = await browser.newContext()
    const bob = await browser.newContext()
    const bobNetwork = await syncNetwork(bob)
    const shared = `Shared/${c.file}`
    try {
      const pageA = await alice.newPage()
      await useSyncServer(pageA, server.url)
      const a = await openInKitFrame(pageA, baseURL!, c.file, await c.fixture(), {}, { ...signedIn(DEV_PRINCIPALS.alice), modes: c.modes ?? {} })
      await c.shows(a.kit, c.count)
      const link = await shareFromTab(pageA, c.title)
      expect(link).toMatch(/\/s\/\S+$/)
      await expect(status(pageA)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })

      const pageB = await bob.newPage()
      await useSyncServer(pageB, server.url)
      const b = await openKitWorkspace(pageB, baseURL!, {}, { ...signedIn(DEV_PRINCIPALS.bob), modes: c.modes ?? {} })
      await openSharedLink(pageB, link)
      const kitB = activeKit(pageB)
      await c.shows(kitB, c.count)
      expect(existsSync(path.join(b.host.root, shared))).toBe(true)
      await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 15_000 })
      await expect.poll(() => sameReplicas(pageA, c.file, pageB, shared), { timeout: 15_000 }).toBe('same')

      // Live, each way.
      await c.edit(pageA, a.kit, 0)
      await c.shows(a.kit, c.count + 1)
      await c.shows(kitB, c.count + 1)
      await c.edit(pageB, kitB, 1)
      await c.shows(kitB, c.count + 2)
      await c.shows(a.kit, c.count + 2)

      // Bob offline; both edit; back online, both have both edits.
      await bobNetwork.setOnline(false)
      await expect(status(pageB)).not.toHaveAttribute('data-state', 'online', { timeout: 30_000 })
      await c.edit(pageB, kitB, 2)
      await c.shows(kitB, c.count + 3)
      await c.edit(pageA, a.kit, 3)
      await c.shows(a.kit, c.count + 3)
      await bobNetwork.setOnline(true)
      await expect(status(pageB)).toHaveAttribute('data-state', 'online', { timeout: 60_000 })
      await expect.poll(() => sameReplicas(pageA, c.file, pageB, shared), { timeout: 60_000 }).toBe('same')
      await c.shows(a.kit, c.count + 4)
      await c.shows(kitB, c.count + 4)
    } finally {
      await alice.close()
      await bob.close()
      await server.stop()
    }
  })
}
