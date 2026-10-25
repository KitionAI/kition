import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test'
import type { DesktopHost } from './desktopHost'
import { openInKitFrame, openKitWorkspace } from './embeddedKit'

const NOTE_UI = path.join(process.cwd(), 'public', 'kits', 'note-ui')

/** Whether the Note kit's pinned package is in `public/kits/note-ui` (`make kit-fetch`). */
export const noteKitPackaged = existsSync(path.join(NOTE_UI, 'kit-ui.json')) && existsSync(path.join(NOTE_UI, 'engine', 'kition_note_sdk_bg.wasm'))

/** Fails, never skips, without the Note kit's package: the specs that use it are gates. */
export function requireNoteKit() {
  expect(noteKitPackaged, 'public/kits/note-ui is missing: run make kit-fetch (or scripts/build-kit-ui.sh note)').toBe(true)
}

/**
 * Notes save themselves a second after a change; specs that check unsaved edits and Save turn
 * that off (the kit's storage key `kit.note.autosave`), unless `autosave` is set.
 */
async function noteAutosave(page: Page, on: boolean) {
  await page.addInitScript((value) => window.localStorage.setItem('kit.note.autosave', value), on ? 'on' : 'off')
}

/**
 * Opens the note `name` (written to the workspace from `text`, beside `others`) in the Note kit's
 * editor in Kition, and waits for its text. Answers the kit's frame, the workspace host, and the
 * files Kition saved through its file API (with `persist`, also written to the workspace). The
 * note does not save itself unless `autosave`.
 */
export async function openNote(page: Page, baseURL: string, name: string, text: string, others: Record<string, Buffer> = {}, options: Parameters<typeof openKitWorkspace>[3] & { autosave?: boolean } = {}) {
  requireNoteKit()
  await noteAutosave(page, options.autosave === true)
  const opened = await openInKitFrame(page, baseURL, name, Buffer.from(text), others, options)
  await expect(opened.kit.getByTestId('note-editor')).toBeVisible({ timeout: 60_000 })
  return opened
}

/** The Note kit's page in the active kit tab (for `evaluate`). */
export async function noteFrame(page: Page): Promise<Frame> {
  let found: Frame | null = null
  await expect.poll(async () => {
    const element = await page.locator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]').elementHandle({ timeout: 1_000 }).catch(() => null)
    found = (await element?.contentFrame()) ?? null
    return found?.url().includes('/kits/note-ui/') ?? false
  }).toBe(true)
  return found!
}

/**
 * The note's text as its editor holds it. The Note kit draws the note on a canvas (its engine lays
 * it out and paints it) and keeps the text in a visually hidden document for assistive technology.
 */
export async function noteText(page: Page) {
  return (await noteFrame(page)).evaluate(() => document.querySelector('[data-testid="note-text"]')?.textContent ?? '')
}

/** The pictures the note draws (image-only lines whose picture was read through the host). */
export async function notePictures(page: Page) {
  return (await noteFrame(page)).evaluate(() => (document.querySelector('[data-testid="note-text"]')?.getAttribute('data-pictures') ?? '').split('\n').filter(Boolean))
}

/** Waits until the note holds `text` (through its accessible document). */
export async function waitForNoteText(page: Page, text: string) {
  await expect.poll(() => noteText(page), { timeout: 30_000 }).toContain(text)
}

/**
 * Puts the caret right after `text` (its first occurrence) the way a person can on the canvas:
 * Find (Mod+F) selects it, Escape closes the find bar, and ArrowRight collapses the selection at
 * its end. With `select`, the found text stays selected.
 */
export async function caretAfter(page: Page, kit: FrameLocator, text: string, { select = false } = {}) {
  await waitForNoteText(page, text)
  await kit.getByTestId('note-canvas').click({ position: { x: 10, y: 10 } })
  await pressCommand(page, kit, 'f')
  const input = kit.getByTestId('note-find-input')
  await expect(input).toBeVisible()
  await input.fill(text)
  await input.press('Enter')
  await input.press('Escape')
  await expect(kit.getByTestId('note-find')).toHaveCount(0)
  // The keyboard goes back to the note a frame after Find closes; a key pressed before then is lost.
  await expect(kit.getByTestId('kit-text-sink')).toBeFocused()
  if (!select) await page.keyboard.press('ArrowRight')
}

/** Presses `key` with the platform's command key, as the kit reads the platform (`navigator.platform`). */
export async function pressCommand(page: Page, kit: FrameLocator, key: string) {
  const mac = await kit.locator('body').evaluate(() => /Mac|iPhone|iPad/i.test(navigator.platform))
  await page.keyboard.press(`${mac ? 'Meta' : 'Control'}+${key}`)
}

/** Another program changed `path` in the workspace, and the desktop shell's watcher says so. */
export async function changedOnDisk(host: DesktopHost, path: string) {
  await host.emit('desktop:document:external-change', { path, eventType: 'change', mtimeMs: Date.now() })
}

/** The lines `after` has that `before` lacks and the reverse (common prefix and suffix removed). */
export function lineDiff(before: string, after: string) {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  return { removed: a.slice(start, endA), added: b.slice(start, endB) }
}
