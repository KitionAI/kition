/**
 * The host-matrix checks every kit of interaction group B (photo, vector, fig, board, film, effect,
 * cad, cube) goes through, written once over a `KitCase`: how to make the kit's file, read a saved
 * one back with the kit's own engine, wait for the editor, and make one edit in it. Each kit's spec
 * calls `hostMatrix(kitCase)` and adds its own detail tests.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'
import type { DesktopHost } from '../helpers/desktopHost'
import { kitEngine, openInKitFrame, openKitWorkspace, openTreeFile, type KitModes } from '../helpers/embeddedKit'
import { dismissFirstRunActivation } from '../helpers/onboarding'
import { collectErrors, tags, type HostRow } from './support'

/** A kit's engine loaded in Node: `create`, `open`, and the document's `execute`, `inspect`, `save`. */
export type NodeDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
export type NodeKit = Record<string, { create(name: string, width: number, height: number): NodeDocument; open(name: string, bytes: Uint8Array): NodeDocument }>

/** The engine of `kit` in its package, with the document class `documentClass`. */
export function nodeEngine(kit: string, documentClass: string) {
  const engine = kitEngine<NodeKit>(kit, `kition_${kit}_sdk`)
  return {
    built: engine.built,
    /** A new document of `width` × `height`, edited by `build`, saved to bytes. */
    make: async (name: string, width: number, height: number, build: (doc: NodeDocument) => void = () => undefined) => {
      const sdk = await engine.load()
      const doc = sdk[documentClass]!.create(name, width, height)
      build(doc)
      const bytes = Buffer.from(doc.save())
      doc.free()
      return bytes
    },
    /** What the engine reads in `bytes` (its `inspect()` JSON). */
    inspect: async (name: string, bytes: Buffer) => {
      const sdk = await engine.load()
      const doc = sdk[documentClass]!.open(name, bytes)
      const state = JSON.parse(doc.inspect()) as Record<string, any>
      doc.free()
      return state
    },
  }
}

export type KitCase = {
  /** The kit's name (`photo`), its test-id prefix, and the tag of its tests. */
  kit: string
  /** The create menu's group label and the kit's create test id suffix (`workspace-create-<kit>`). */
  createGroup: string
  /** The name of a new file the create menu makes (`Untitled photo.psd`). */
  createdName: string
  /** The file the matrix opens, at the workspace root, and the files beside it (a film's clip). */
  file: string
  others?: () => Promise<Record<string, Buffer>>
  /** The file's bytes; `variant` makes a different document, as another program would write. */
  fixture: () => Promise<Buffer>
  variant: () => Promise<Buffer>
  /** What the matrix compares: a number read from saved bytes by the engine. */
  measure: (bytes: Buffer) => Promise<number>
  /** The measure of `fixture`, of `fixture` after one `edit`, and of `variant`. */
  counts: { fixture: number; edited: number; variant: number }
  /** Waits until the editor showing the workspace file `name` shows a document whose measure is `count`. */
  shows: (page: Page, kit: FrameLocator, count: number, name: string) => Promise<void>
  /** Makes one edit through the editor's own UI (the measure goes from `fixture` to `edited`). */
  edit: (page: Page, kit: FrameLocator) => Promise<void>
  /** Saves, undoes, and redoes through the editor; kit-editor's own buttons (`<kit>-save`) by default. */
  save?: (page: Page, kit: FrameLocator) => Promise<void>
  undo?: (page: Page, kit: FrameLocator) => Promise<void>
  redo?: (page: Page, kit: FrameLocator) => Promise<void>
  /** The editor's unsaved-edits mark; kit-editor's `<kit>-unsaved` by default. */
  unsaved?: (kit: FrameLocator) => Locator
  /** Puts the keyboard where the kit's shortcuts are read, after an edit (CAD's command line keeps it). */
  focusForKeys?: (page: Page, kit: FrameLocator) => Promise<void>
  /** Kit editor display modes to pin (`{ 'kit.cad': 'classic' }`). */
  modes?: KitModes
  viewport?: { width: number; height: number }
  /** Console messages known to be harmless for this kit. */
  ignoreErrors?: RegExp[]
  /** Matrix rows this kit leaves out, with why (written in the spec's header too). */
  skip?: Partial<Record<HostRow, string>>
  timeout?: number
}

const ACTIVE_FRAME = '[data-testid="kit-frame"][data-active="true"]'
const activeKit = (page: Page) => page.frameLocator(`${ACTIVE_FRAME} [data-testid="kit-frame-window"]`)

/**
 * The live document of the kit editor showing `name`, as the Kit AI bridge's `inspect` answers it
 * (Kition's development test hook), for a kit whose editor draws its counts on a canvas.
 */
export async function liveDocument(page: Page, name: string) {
  return page.evaluate(async (wanted) => (window.__KITION_KIT_TEST__?.inspect ? window.__KITION_KIT_TEST__.inspect(wanted).catch(() => null) : null), name)
}

/** Reloads Kition and opens `name` again from the tree, as a person reopening the workspace would. */
async function reopen(page: Page, name: string) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissFirstRunActivation(page)
  return openTreeFile(page, name)
}

/** Another program wrote `bytes` to `name`, and the desktop shell's watcher says so. */
async function writeOutside(host: DesktopHost, name: string, bytes: Buffer) {
  await fs.writeFile(path.join(host.root, name), bytes)
  await host.emit('desktop:document:external-change', { path: name, eventType: 'change', mtimeMs: Date.now() })
}

/** The kit's command key: a Mac's Meta, Control elsewhere, as the kit reads `navigator.platform`. */
async function commandKey(kit: FrameLocator) {
  return (await kit.locator('body').evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))) ? 'Meta' : 'Control'
}

/** The bytes of the last save of `name` Kition received, or of the workspace file with `persist`. */
const lastSave = (saves: Array<{ path: string | null; bytes: Buffer }>, name: string) => saves.filter((save) => save.path === name).at(-1)?.bytes ?? null

/**
 * The host matrix for one kit: H1 create, H2 open, H3 round trip, H4 undo and redo, H5 a change on
 * disk with and without unsaved edits, H6 closing a tab with unsaved edits, H7 switching tabs,
 * H8 a damaged file, H15 the kit's own shortcuts. The rows Kition's mock desktop cannot drive
 * (H9-H14) are covered or excused in each kit's spec.
 */
export function hostMatrix(c: KitCase) {
  const engineMissing = `the ${c.kit} kit is not built into public/kits/${c.kit}-ui (scripts/fetch-kits.mjs)`
  const built = kitEngine(c.kit, `kition_${c.kit}_sdk`).built
  const others = async () => (c.others ? await c.others() : {})
  const options = (persist: boolean) => ({ persist, modes: c.modes ?? {} })
  const skipped = (row: HostRow) => c.skip?.[row]
  const unsaved = (kit: FrameLocator) => (c.unsaved ? c.unsaved(kit) : kit.getByTestId(`${c.kit}-unsaved`))
  const save = (page: Page, kit: FrameLocator) => (c.save ? c.save(page, kit) : kit.getByTestId(`${c.kit}-save`).click())
  const undo = (page: Page, kit: FrameLocator) => (c.undo ? c.undo(page, kit) : kit.getByTestId(`${c.kit}-undo`).click())
  const redo = (page: Page, kit: FrameLocator) => (c.redo ? c.redo(page, kit) : kit.getByTestId(`${c.kit}-redo`).click())
  // The mocked desktop's own noise: kit pages' CSP meta tags, and the mock API's answer to the
  // runtime bridge's event stream.
  const ignore = [/frame-ancestors' is ignored when delivered via a <meta> element/, /EventSource's response has a MIME type/, ...(c.ignoreErrors ?? [])]

  test.describe(`${c.kit} host matrix`, () => {
    if (c.viewport) test.use({ viewport: c.viewport })
    test.beforeEach(() => {
      test.skip(!built, engineMissing)
      test.setTimeout(c.timeout ?? 180_000)
    })

    test(`H1: the create menu makes a new ${c.kit} file with the kit's engine and opens it`, tags(c.kit, ['H1'], true), async ({ page, baseURL }) => {
      test.skip(Boolean(skipped('H1')), skipped('H1'))
      const errors = collectErrors(page, ignore)
      const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true, modes: c.modes ?? {} })
      try {
        await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
        await page.getByRole('group', { name: c.createGroup }).getByTestId(`workspace-create-${c.kit}`).click()
        await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toContain(c.createdName)
        await expect(page.locator(ACTIVE_FRAME)).toBeVisible()
        await expect(page.getByTestId('kit-open-failed')).toHaveCount(0)
        // The new file is one the kit's own engine opens.
        await c.measure(lastSave(saves, c.createdName)!)
        await errors.expectNone()
      } finally {
        await host.dispose()
      }
    })

    test(`H2+H3: opens a ${c.kit} file, edits it, saves it, and reopens what was saved`, tags(c.kit, ['H2', 'H3'], true), async ({ page, baseURL }) => {
      const errors = collectErrors(page, ignore)
      const { host, saves, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(true))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await expect(page.getByTestId('kit-opening')).toHaveCount(0)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        await expect(unsaved(kit)).toBeVisible()
        await save(page, kit)
        await expect(unsaved(kit)).toHaveCount(0, { timeout: 30_000 })
        await expect.poll(() => saves.some((save) => save.path === c.file), { timeout: 30_000 }).toBe(true)
        expect(await c.measure(lastSave(saves, c.file)!)).toBe(c.counts.edited)
        expect(await c.measure(await fs.readFile(path.join(host.root, c.file)))).toBe(c.counts.edited)

        const again = await reopen(page, c.file)
        await c.shows(page, again, c.counts.edited, c.file)
        await expect(unsaved(again)).toHaveCount(0)
        await errors.expectNone()
      } finally {
        await host.dispose()
      }
    })

    test(`H4: undo takes a ${c.kit} edit back and redo puts it again`, tags(c.kit, ['H4'], true), async ({ page, baseURL }) => {
      test.skip(Boolean(skipped('H4')), skipped('H4'))
      const { host, saves, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(false))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        await undo(page, kit)
        await c.shows(page, kit, c.counts.fixture, c.file)
        await redo(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        // Undo and redo leave a document that saves as what it shows.
        await save(page, kit)
        await expect.poll(() => saves.some((save) => save.path === c.file), { timeout: 30_000 }).toBe(true)
        expect(await c.measure(lastSave(saves, c.file)!)).toBe(c.counts.edited)
      } finally {
        await host.dispose()
      }
    })

    test(`H5: a ${c.kit} file changed on disk shows at once without unsaved edits`, tags(c.kit, ['H5'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(true))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await writeOutside(host, c.file, await c.variant())
        await c.shows(page, kit, c.counts.variant, c.file)
        await expect(unsaved(kit)).toHaveCount(0)
      } finally {
        await host.dispose()
      }
    })

    test(`H5: a ${c.kit} file changed on disk never replaces unsaved edits, and a save never overwrites the change unasked`, tags(c.kit, ['H5'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(true))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        const outside = await c.variant()
        await writeOutside(host, c.file, outside)
        // Past the kit's own file check: the unsaved edit is still there.
        await page.waitForTimeout(4_000)
        await c.shows(page, kit, c.counts.edited, c.file)
        await expect(unsaved(kit)).toBeVisible()
        // Saving now must not silently replace what the other program wrote.
        await save(page, kit)
        await page.waitForTimeout(3_000)
        const onDisk = await fs.readFile(path.join(host.root, c.file))
        expect(onDisk.equals(outside), 'the save replaced the file changed on disk without asking').toBe(true)
        await c.shows(page, kit, c.counts.edited, c.file)
      } finally {
        await host.dispose()
      }
    })

    test(`H6: closing a ${c.kit} tab with unsaved edits asks first: cancel keeps it, save saves and closes`, tags(c.kit, ['H6'], true), async ({ page, baseURL }) => {
      const { host, saves, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(true))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        await expect(unsaved(kit)).toBeVisible()
        const close = page.locator('.document-tab.is-active .document-tab-close')
        const question = page.getByTestId('unsaved-close')

        // Cancel: the tab stays, with its edits.
        await close.click()
        await expect(question).toBeVisible()
        await page.getByTestId('unsaved-close-cancel').click()
        await expect(question).toHaveCount(0)
        await c.shows(page, activeKit(page), c.counts.edited, c.file)
        await expect(unsaved(activeKit(page))).toBeVisible()

        // Save: the edits are saved, then the tab closes; reopened, the file has them.
        await close.click()
        await page.getByTestId('unsaved-close-save').click()
        await expect(page.locator(ACTIVE_FRAME)).toHaveCount(0, { timeout: 30_000 })
        expect(await c.measure(lastSave(saves, c.file)!)).toBe(c.counts.edited)
        const again = await openTreeFile(page, c.file)
        await c.shows(page, again, c.counts.edited, c.file)
        await expect(unsaved(again)).toHaveCount(0)
      } finally {
        await host.dispose()
      }
    })

    test(`H6: closing a ${c.kit} tab with unsaved edits and choosing not to save drops them`, tags(c.kit, ['H6']), async ({ page, baseURL }) => {
      const { host, saves, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(true))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        await page.keyboard.press(`${await commandKey(kit)}+w`).catch(() => undefined)
        // The kit may keep Cmd+W; the tab's close button asks the same question. The question may
        // take a moment to open, and its overlay then covers the close button.
        const asked = await page.getByTestId('unsaved-close').waitFor({ timeout: 3_000 }).then(() => true, () => false)
        if (!asked) await page.locator('.document-tab.is-active .document-tab-close').click()
        await page.getByTestId('unsaved-close-discard').click()
        await expect(page.locator(ACTIVE_FRAME)).toHaveCount(0)
        expect(saves.filter((save) => save.path === c.file)).toEqual([])
        const again = await openTreeFile(page, c.file)
        await c.shows(page, again, c.counts.fixture, c.file)
      } finally {
        await host.dispose()
      }
    })

    test(`H7: switching away from a ${c.kit} tab and back keeps its unsaved edits`, tags(c.kit, ['H7'], true), async ({ page, baseURL }) => {
      const second = `Second${path.extname(c.file)}`
      const files = { ...(await others()), [second]: await c.fixture() }
      const { host, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), files, options(false))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        const other = await openTreeFile(page, second)
        await c.shows(page, other, c.counts.fixture, second)
        await page.locator('.document-tab', { hasText: path.basename(c.file, path.extname(c.file)) }).first().click()
        const back = activeKit(page)
        await c.shows(page, back, c.counts.edited, c.file)
        await expect(unsaved(back)).toBeVisible()
        // A narrower window, then the full one again: the document is still what it was.
        const size = page.viewportSize()!
        await page.setViewportSize({ width: Math.max(900, Math.round(size.width * 0.6)), height: size.height })
        await page.setViewportSize(size)
        await c.shows(page, back, c.counts.edited, c.file)
      } finally {
        await host.dispose()
      }
    })

    test(`H8: a damaged ${c.kit} file fails plainly and leaves Kition working`, tags(c.kit, ['H8']), async ({ page, baseURL }) => {
      const broken = `Broken${path.extname(c.file)}`
      const files = { ...(await others()), [broken]: Buffer.from('this is not a real file\u0000\u0001\u0002') }
      const { host } = await openKitWorkspace(page, baseURL!, { ...files, [c.file]: await c.fixture() }, options(false))
      try {
        await page.locator('.document-tree-row', { hasText: 'Broken' }).first().click()
        // The kit or Kition says the file cannot be opened; nothing is written over it.
        const failed = async () =>
          (await page.getByTestId('kit-open-failed').isVisible()) ||
          (await activeKit(page).getByTestId('kit-render-failure').isVisible().catch(() => false)) ||
          (await activeKit(page).locator('[role="alert"]').first().isVisible().catch(() => false))
        await expect.poll(failed, { timeout: 60_000, message: 'a damaged file says it cannot be opened' }).toBe(true)
        expect((await fs.readFile(path.join(host.root, broken))).toString('latin1')).toBe('this is not a real file\u0000\u0001\u0002')
        // Another file still opens.
        const kit = await openTreeFile(page, c.file)
        await c.shows(page, kit, c.counts.fixture, c.file)
      } finally {
        await host.dispose()
      }
    })

    test(`H15: the ${c.kit} kit's own save and undo shortcuts reach the kit`, tags(c.kit, ['H15']), async ({ page, baseURL }) => {
      test.skip(Boolean(skipped('H15')), skipped('H15'))
      const { host, saves, kit } = await openInKitFrame(page, baseURL!, c.file, await c.fixture(), await others(), options(false))
      try {
        await c.shows(page, kit, c.counts.fixture, c.file)
        await c.edit(page, kit)
        await c.shows(page, kit, c.counts.edited, c.file)
        await c.focusForKeys?.(page, kit)
        const mod = await commandKey(kit)
        await page.keyboard.press(`${mod}+s`)
        await expect.poll(() => saves.some((save) => save.path === c.file), { timeout: 30_000 }).toBe(true)
        expect(await c.measure(lastSave(saves, c.file)!)).toBe(c.counts.edited)
        await page.keyboard.press(`${mod}+z`)
        await c.shows(page, kit, c.counts.fixture, c.file)
        // Kition's own tab stays open: the kit's keys never close or switch it.
        await expect(page.locator(ACTIVE_FRAME)).toBeVisible()
      } finally {
        await host.dispose()
      }
    })
  })
}
