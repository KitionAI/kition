/**
 * Helpers for the interaction specs of the document kits (note, table, sheet, doc, slide, pdf,
 * html, design): the host-matrix steps every kit goes through, on the desktop host
 * (e2e/helpers/desktopHost.ts) with the kit's real package in public/kits/.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import type { DesktopHost } from '../helpers/desktopHost'
import { openInKitFrame, openKitWorkspace, openTreeFile } from '../helpers/embeddedKit'
import { pressCommand } from '../helpers/noteKit'
import { dismissFirstRunActivation } from '../helpers/onboarding'
import { collectErrors, tags } from './support'

/** The active tab's kit editor. */
function activeKit(page: Page): FrameLocator {
  return page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
}

/** The workspace tab titled `title` in the tab strip. */
function tab(page: Page, title: string) {
  return page.locator(`.document-tab[data-tab-title="${title}"]`)
}

/** Closes the workspace tab titled `title` with its close button. */
async function closeTab(page: Page, title: string) {
  await tab(page, title).hover()
  await tab(page, title).locator('.document-tab-close').click()
}

/** Reloads Kition (a restart of the window) and opens `name` from the tree again. */
async function reopen(page: Page, name: string) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await dismissFirstRunActivation(page)
  return openTreeFile(page, name)
}

/** Another program wrote `bytes` to `name` in the workspace, and the desktop watcher says so. */
async function writeOnDisk(host: DesktopHost, name: string, bytes: Buffer | string) {
  // A later modification time than the file's, so the new stamp differs even within a second.
  const file = path.join(host.root, name)
  await fs.writeFile(file, bytes)
  const later = new Date(Date.now() + 5_000)
  await fs.utimes(file, later, later)
  await host.emit('desktop:document:external-change', { path: name, eventType: 'change', mtimeMs: later.getTime() })
}

/** The file `name` in the workspace, as it is on disk now. */
export function onDisk(host: DesktopHost, name: string) {
  return fs.readFile(path.join(host.root, name))
}

/** Waits until the kit's replica stops changing: the keys sent to it have all been applied. */
async function settled(read: () => Promise<string>) {
  let last = '\u0000'
  await expect
    .poll(
      async () => {
        const now = await read()
        const still = now === last
        last = now
        return still
      },
      { timeout: 15_000, intervals: [400] },
    )
    .toBe(true)
}

/** Switches Kition's language as the settings' language control does; open kits follow it. */
async function setLocale(page: Page, language: string) {
  await page.evaluate(async (wanted) => {
    const i18nPath = '/src/i18n/index.ts'
    const { setCurrentLocale } = await import(/* @vite-ignore */ i18nPath)
    await setCurrentLocale(wanted)
  }, language)
}

/** Console noise of the mocked desktop host that says nothing about a kit. */
const HOST_NOISE = [/frame-ancestors' is ignored when delivered via a <meta> element/, /EventSource's response has a MIME type/, /Failed to load resource: the server responded with a status of 404/]

/** The bar a kit shows when its file changed on disk while it has unsaved edits, and its two answers. */
type ConflictBar = { bar: string; keep: string; reload: string }

/**
 * What the host matrix needs to know of one kit. Each kit's document has a count the person sees
 * in the editor and the engine reads from the saved bytes (sheets, pages, slides, records, …);
 * `edit` adds one, the way a person does.
 */
export type KitSpec = {
  kit: string
  /** The kit editor's test id prefix: `<prefix>-save`, `<prefix>-unsaved`. */
  prefix: string
  /** The fixture's file name in the workspace, and its tab's title. */
  name: string
  title: string
  fixture: () => Promise<Buffer>
  /** A version of the file another program wrote: its count is `variantCount`. */
  variant: () => Promise<Buffer>
  variantCount: number
  base: number
  options?: Parameters<typeof openInKitFrame>[5]
  viewport?: { width: number; height: number }
  /** Waits until the editor shows the document. */
  ready: (kit: FrameLocator, page: Page) => Promise<void>
  /** The count the editor shows. */
  shown: (kit: FrameLocator, page: Page) => Promise<number>
  /** The count in saved bytes, as the kit's engine reads them. */
  saved: (bytes: Buffer) => Promise<number>
  /** Adds one, as a person does. */
  edit: (kit: FrameLocator, page: Page) => Promise<void>
  /** Gives the editor the keyboard (for shortcuts), as a click on the document does. */
  focus: (kit: FrameLocator, page: Page) => Promise<void>
  undo?: (kit: FrameLocator, page: Page) => Promise<void>
  redo?: (kit: FrameLocator, page: Page) => Promise<void>
  conflict?: ConflictBar
  /** The create menu's group, when the kit makes new files; the new file's name. */
  create?: { group: string; name: string; count: number }
  /** An agent step through the Kit AI bridge that adds one (H12). */
  agent?: { command: string; params: Record<string, unknown> }
  /** Bytes the kit cannot open (H8); none for a text format, where any bytes are a document. */
  damaged?: Buffer
  /** Whether Kition keeps the document's version history (the kit keeps a replica); default true. */
  history?: boolean
  /** Runs before the page loads (a kit's stored preferences). */
  prepare?: (page: Page) => Promise<void>
  /** After Load the new version (H5): the editor shows the file's version, nothing unsaved; a kit that merges checks its own way. */
  afterReload?: (kit: FrameLocator, page: Page) => Promise<void>
}

/** The Kit AI bridge requests for `path`, sent once the test lets them through (`release`). */
function agentBridge(path: string, kitId: string, step: { command: string; params: Record<string, unknown> }) {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const posted: Array<Record<string, unknown>> = []
  let streams = 0
  const routes = async (page: Page) => {
    await page.route('**/v1/kits/bridge', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      streams += 1
      if (streams > 1) return route.fulfill({ status: 204, body: '' })
      await released
      const messages = [
        { jsonrpc: '2.0', method: 'bridge.ready', params: { session: 5 } },
        { jsonrpc: '2.0', id: 1, method: 'kit/documents', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'kit/call', params: { path, kit: kitId, tool: 'run', arguments: { steps: [step], save: true } } },
      ]
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }, body: messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join('') })
    })
    await page.route('**/v1/kits/bridge?**', async (route) => {
      posted.push(route.request().postDataJSON() as Record<string, unknown>)
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 200, message: 'success', data: {} }) })
    })
  }
  const answer = async (id: number) => {
    await expect.poll(() => posted.find((message) => message.id === id), { timeout: 30_000 }).toBeTruthy()
    return posted.find((message) => message.id === id)!
  }
  return { routes, release: () => release(), answer }
}

/** Saves with the kit's Save button until nothing is unsaved (keys may still be on their way to the engine). */
export async function saveNow(kit: FrameLocator, prefix: string) {
  await expect(async () => {
    await kit.getByTestId(`${prefix}-save`).click({ timeout: 2_000 })
    await expect(kit.getByTestId(`${prefix}-unsaved`)).toHaveCount(0, { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

/**
 * The host matrix (the interaction test plan, H1 to H15) for one kit: the rows every kit goes
 * through on the desktop host. Rows a kit cannot be checked on here are named in its spec's header.
 */
export function hostMatrix(spec: KitSpec) {
  const { kit: id, prefix, name, title } = spec
  const undo = spec.undo ?? ((kit: FrameLocator) => kit.getByTestId(`${prefix}-undo`).click())
  const redo = spec.redo ?? ((kit: FrameLocator) => kit.getByTestId(`${prefix}-redo`).click())
  const openFixture = async (page: Page, baseURL: string, file = name, bytes?: Buffer, others: Record<string, Buffer> = {}, options: Parameters<typeof openInKitFrame>[5] = {}) => {
    await spec.prepare?.(page)
    return openInKitFrame(page, baseURL, file, bytes ?? (await spec.fixture()), others, { persist: true, ...spec.options, ...options })
  }
  const shownIs = (kit: FrameLocator, page: Page, count: number) => expect.poll(() => spec.shown(kit, page), { timeout: 20_000 }).toBe(count)

  test.describe(`${id} host matrix`, () => {
    if (spec.viewport) test.use({ viewport: spec.viewport })
    test.setTimeout(180_000)

    if (spec.create) {
      const create = spec.create
      test(`H1 makes a new ${id} file from the create menu and opens it`, tags(id, ['H1']), async ({ page, baseURL }) => {
        const errors = collectErrors(page, HOST_NOISE)
        await spec.prepare?.(page)
        const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true, ...spec.options })
        try {
          await expect(page.locator('.document-tree-row').first()).toBeVisible({ timeout: 30_000 }).catch(() => undefined)
          await dismissFirstRunActivation(page)
          await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
          await page.getByRole('group', { name: create.group }).getByTestId(`workspace-create-${id}`).click()
          await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual([create.name])
          expect(await spec.saved(saves[0]!.bytes)).toBe(create.count)
          const kit = activeKit(page)
          await spec.ready(kit, page)
          await shownIs(kit, page, create.count)
          await expect(kit.getByTestId(`${prefix}-unsaved`)).toHaveCount(0)
          await errors.expectNone()
        } finally {
          await host.dispose()
        }
      })
    }

    test(`H2 H3 opens a ${id} file, edits and saves it, and opens it again with the edit`, tags(id, ['H2', 'H3'], true), async ({ page, baseURL }) => {
      const errors = collectErrors(page, HOST_NOISE)
      const { host, saves, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await shownIs(kit, page, spec.base)
        await expect(page.getByTestId('kit-opening')).toHaveCount(0)
        await spec.edit(kit, page)
        await shownIs(kit, page, spec.base + 1)
        await expect(kit.getByTestId(`${prefix}-unsaved`)).toBeVisible()
        await saveNow(kit, prefix)
        expect(saves.every((save) => save.path === name)).toBe(true)
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)

        const again = await reopen(page, name)
        await spec.ready(again, page)
        await shownIs(again, page, spec.base + 1)
        await expect(again.getByTestId(`${prefix}-unsaved`)).toHaveCount(0)
        await errors.expectNone()
      } finally {
        await host.dispose()
      }
    })

    test(`H4 undoes and redoes an edit to a ${id} file`, tags(id, ['H4'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        await shownIs(kit, page, spec.base + 1)
        await undo(kit, page)
        await shownIs(kit, page, spec.base)
        await redo(kit, page)
        await shownIs(kit, page, spec.base + 1)
        await saveNow(kit, prefix)
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)
      } finally {
        await host.dispose()
      }
    })

    test(`H5 a ${id} file changed on disk shows at once when nothing is unsaved`, tags(id, ['H5'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await shownIs(kit, page, spec.base)
        await writeOnDisk(host, name, await spec.variant())
        await shownIs(kit, page, spec.variantCount)
        await expect(kit.getByTestId(`${prefix}-unsaved`)).toHaveCount(0)
      } finally {
        await host.dispose()
      }
    })

    test(`H5 a ${id} file changed on disk while edits are unsaved asks; the person keeps theirs or loads the new file`, tags(id, ['H5'], true), async ({ page, baseURL }) => {
      const conflict = spec.conflict ?? { bar: `${prefix}-file-changed`, keep: `${prefix}-keep-mine`, reload: `${prefix}-reload` }
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        await shownIs(kit, page, spec.base + 1)
        const variant = await spec.variant()
        await writeOnDisk(host, name, variant)
        // Never replaced unseen: the person is asked, and the file keeps the other program's version.
        await expect(kit.getByTestId(conflict.bar)).toBeVisible({ timeout: 15_000 })
        expect((await onDisk(host, name)).equals(variant)).toBe(true)
        await shownIs(kit, page, spec.base + 1)

        // Keep my edits: the next save writes them.
        await kit.getByTestId(conflict.keep).click()
        await expect(kit.getByTestId(conflict.bar)).toHaveCount(0)
        await saveNow(kit, prefix)
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)

        // Another change from outside, more edits; this time the person loads the new file.
        await spec.edit(kit, page)
        await writeOnDisk(host, name, variant)
        await expect(kit.getByTestId(conflict.bar)).toBeVisible({ timeout: 15_000 })
        await kit.getByTestId(conflict.reload).click()
        if (spec.afterReload) await spec.afterReload(kit, page)
        else {
          await shownIs(kit, page, spec.variantCount)
          await expect(kit.getByTestId(`${prefix}-unsaved`)).toHaveCount(0)
        }
      } finally {
        await host.dispose()
      }
    })

    test(`H6 closing a ${id} tab with unsaved edits asks: Cancel keeps it, Save writes them, Don't save drops them`, tags(id, ['H6', 'H15'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      const dialog = page.getByTestId('unsaved-close')
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        await expect(kit.getByTestId(`${prefix}-unsaved`)).toBeVisible()

        // Cancel: the tab stays, with its edit.
        await closeTab(page, title)
        await expect(dialog).toBeVisible({ timeout: 10_000 })
        await dialog.getByTestId('unsaved-close-cancel').click()
        await expect(dialog).toHaveCount(0)
        await expect(tab(page, title)).toHaveCount(1)
        await shownIs(kit, page, spec.base + 1)

        // Save: the edit reaches the file, then the tab closes.
        await closeTab(page, title)
        await dialog.getByTestId('unsaved-close-save').click()
        await expect(tab(page, title)).toHaveCount(0, { timeout: 30_000 })
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)

        // Don't save, from the keyboard's Close Tab inside the editor: the file keeps what was saved.
        const again = await openTreeFile(page, name)
        await spec.ready(again, page)
        await spec.edit(again, page)
        await expect(again.getByTestId(`${prefix}-unsaved`)).toBeVisible()
        await spec.focus(again, page)
        await pressCommand(page, again, 'w')
        await expect(dialog).toBeVisible({ timeout: 10_000 })
        await dialog.getByTestId('unsaved-close-discard').click()
        await expect(tab(page, title)).toHaveCount(0)
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)
      } finally {
        await host.dispose()
      }
    })

    test(`H7 a ${id} tab keeps its unsaved edits while another tab is shown`, tags(id, ['H7']), async ({ page, baseURL }) => {
      const other = `Other${name.slice(name.lastIndexOf('.'))}`
      const { host, kit } = await openFixture(page, baseURL!, name, undefined, { [other]: await spec.variant() })
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        const second = await openTreeFile(page, other)
        await spec.ready(second, page)
        await shownIs(second, page, spec.variantCount)
        await page.setViewportSize({ width: 1280, height: 800 })
        await tab(page, title).click()
        const first = activeKit(page)
        await shownIs(first, page, spec.base + 1)
        await expect(first.getByTestId(`${prefix}-unsaved`)).toBeVisible()
      } finally {
        await host.dispose()
      }
    })

    if (spec.damaged) {
      const damaged = spec.damaged
      test(`H8 a damaged ${id} file says it cannot be opened, and other files still open`, tags(id, ['H8'], true), async ({ page, baseURL }) => {
        const broken = `Damaged${name.slice(name.lastIndexOf('.'))}`
        const { host, kit } = await openFixture(page, baseURL!, broken, damaged, { [name]: await spec.fixture() })
        try {
          // Kition's frame or the kit says so; never an empty editor that looks like an empty file.
          await expect(kit.getByText(/could not be opened|cannot be opened|could not open|failed to open/i).or(page.getByText(/could not be opened|cannot be opened|could not open/i)).first()).toBeVisible({ timeout: 60_000 })
          expect((await onDisk(host, broken)).equals(damaged)).toBe(true)
          const good = await openTreeFile(page, name)
          await spec.ready(good, page)
          await shownIs(good, page, spec.base)
        } finally {
          await host.dispose()
        }
      })
    }

    test(`H9 a ${id} engine that stops says so on Save, and the file opens again`, tags(id, ['H9'], true), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        await shownIs(kit, page, spec.base + 1)
        // An uncaught error in the kit's engine worker (a trap, a bug) stops it.
        const engineWorker = page.workers().find((worker) => worker.url().includes(`/kits/${id}-ui/`) && /worker/i.test(worker.url()))
        expect(engineWorker, `the ${id} kit runs its engine in a worker`).toBeTruthy()
        await engineWorker!.evaluate(() => {
          setTimeout(() => {
            throw new Error('the engine stopped in a test')
          }, 0)
        })
        // Never a silent save: the person is told it failed, and the file is what it was.
        const before = await onDisk(host, name)
        await kit.getByTestId(`${prefix}-save`).click()
        await expect(kit.getByText(/could not save/i).first()).toBeVisible({ timeout: 15_000 })
        expect((await onDisk(host, name)).equals(before)).toBe(true)
        // Closing without the lost edits and opening the file again starts a new engine.
        await closeTab(page, title)
        const question = page.getByTestId('unsaved-close')
        if (await question.isVisible({ timeout: 5_000 }).catch(() => false)) await question.getByTestId('unsaved-close-discard').click()
        await expect(tab(page, title)).toHaveCount(0, { timeout: 10_000 })
        const again = await openTreeFile(page, name)
        await spec.ready(again, page)
        await shownIs(again, page, spec.base)
        await spec.edit(again, page)
        await shownIs(again, page, spec.base + 1)
      } finally {
        await host.dispose()
      }
    })

    if (spec.history !== false) {
      test(`H10 restores an earlier saved version of a ${id} file from its version history`, tags(id, ['H10'], true), async ({ page, baseURL }) => {
        const { host, kit } = await openFixture(page, baseURL!)
        try {
          await spec.ready(kit, page)
          await spec.edit(kit, page)
          await saveNow(kit, prefix)
          await spec.edit(kit, page)
          await saveNow(kit, prefix)
          await shownIs(kit, page, spec.base + 2)

          await tab(page, title).click({ button: 'right' })
          await page.getByRole('menuitem', { name: 'Version history' }).click()
          const history = page.getByTestId('history-dialog')
          await expect(history).toBeVisible()
          const entries = history.getByTestId('history-entry')
          await expect.poll(() => entries.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
          // The older save is listed after the newer one.
          await entries.nth(1).click()
          await expect(page.getByTestId('history-restore')).toBeEnabled({ timeout: 30_000 })
          await page.getByTestId('history-restore').click()
          await expect(history).toBeHidden()

          const restored = activeKit(page)
          await shownIs(restored, page, spec.base + 1)
          await saveNow(restored, prefix)
          expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)
        } finally {
          await host.dispose()
        }
      })
    }

    if (spec.agent) {
      const step = spec.agent
      test(`H12 the agent edits the open ${id} file through the Kit AI bridge and saves it`, tags(id, ['H12'], true), async ({ page, baseURL }) => {
        const bridge = agentBridge(name, `kit.${id}`, step)
        const { host, kit } = await openFixture(page, baseURL!, name, undefined, {}, { routes: bridge.routes })
        try {
          await spec.ready(kit, page)
          bridge.release()
          const documents = await bridge.answer(1)
          expect(documents.result).toMatchObject({ documents: [expect.objectContaining({ path: name, kit: `kit.${id}`, dirty: false })] })
          const run = await bridge.answer(2)
          expect(run.error).toBeUndefined()
          expect(run.result).toMatchObject({ completed: [expect.objectContaining({ command: step.command, changed: true })], saved: true })
          await shownIs(kit, page, spec.base + 1)
          await expect.poll(async () => spec.saved(await onDisk(host, name)), { timeout: 15_000 }).toBe(spec.base + 1)
          // Whether the person's Undo also takes the agent's edit back is the kit's undo scope
          // (KHP E14a): some kits keep one history, the Note kit keeps one per origin.
        } finally {
          await host.dispose()
        }
      })
    }

    test(`H14 the ${id} editor opens in Kition's language`, tags(id, ['H14']), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await expect(kit.getByTestId(`${prefix}-save`)).toContainText('Save')
        // Kition's language reaches an editor opened after the change.
        await setLocale(page, 'zh-CN')
        await closeTab(page, title)
        const again = await openTreeFile(page, name)
        await expect(again.locator('html')).toHaveAttribute('lang', 'zh-CN', { timeout: 15_000 })
        await expect(again.getByTestId(`${prefix}-save`)).not.toContainText('Save')
      } finally {
        await host.dispose()
      }
    })

    test(`H15 Save from the keyboard in the ${id} editor saves, and Close Tab reaches Kition`, tags(id, ['H15']), async ({ page, baseURL }) => {
      const { host, kit } = await openFixture(page, baseURL!)
      try {
        await spec.ready(kit, page)
        await spec.edit(kit, page)
        await expect(kit.getByTestId(`${prefix}-unsaved`)).toBeVisible()
        await spec.focus(kit, page)
        await expect(async () => {
          await pressCommand(page, kit, 's')
          await expect(kit.getByTestId(`${prefix}-unsaved`)).toHaveCount(0, { timeout: 3_000 })
        }).toPass({ timeout: 30_000 })
        expect(await spec.saved(await onDisk(host, name))).toBe(spec.base + 1)
        await spec.focus(kit, page)
        await pressCommand(page, kit, 'w')
        await expect(tab(page, title)).toHaveCount(0, { timeout: 10_000 })
      } finally {
        await host.dispose()
      }
    })
  })
}
